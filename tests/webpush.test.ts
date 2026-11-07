import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  buildVapidAuthorization,
  bytesToBase64Url,
  encryptPayload,
} from '../worker/src/webpush';
import type { VapidConfig } from '../worker/src/vapid';

/**
 * Web Push 加解密闭环测试：模拟浏览器（UA）侧按 RFC 8291 解密，
 * 验证我们生成的 aes128gcm 消息体能被正确还原。
 *
 * 说明：TypeScript 5.9 的类型化数组泛型与 DOM 的 BufferSource 定义存在摩擦，
 * 测试里也用一份窄化适配（与 worker/src/webpush.ts 中的做法一致）。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const subtle = crypto.subtle as unknown as {
  importKey(
    format: string,
    keyData: unknown,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CryptoKey>;
  generateKey(algorithm: unknown, extractable: boolean, keyUsages: string[]): Promise<CryptoKey | CryptoKeyPair>;
  exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer>;
  deriveBits(algorithm: unknown, baseKey: CryptoKey, length: number): Promise<ArrayBuffer>;
  decrypt(algorithm: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: unknown, key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** HKDF（UA 侧解密用，与被测代码独立实现） */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** 生成一对 UA 密钥（等价于浏览器 pushManager.subscribe 产生的密钥） */
async function createUaKeyPair(): Promise<{
  uaPublicRaw: Uint8Array;
  uaPrivateKey: CryptoKey;
  p256dh: string;
  authSecret: Uint8Array;
  auth: string;
}> {
  const keyPair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const uaPublicRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  return {
    uaPublicRaw,
    uaPrivateKey: keyPair.privateKey,
    p256dh: bytesToBase64Url(uaPublicRaw),
    authSecret,
    auth: bytesToBase64Url(authSecret),
  };
}

/** 按 RFC 8291 解密我们生成的请求体 */
async function uaDecrypt(
  body: Uint8Array,
  uaPrivateKey: CryptoKey,
  uaPublicRaw: Uint8Array,
  authSecret: Uint8Array,
): Promise<string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublicRaw = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const asPublicKey = await subtle.importKey('raw', asPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asPublicKey }, uaPrivateKey, 256));

  const keyInfo = concat([encoder.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw]);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));

  // 去掉尾部的记录分隔符 0x02
  expect(record[record.length - 1]).toBe(0x02);
  return decoder.decode(record.subarray(0, record.length - 1));
}

/** 生成一对 VAPID 密钥（等价于 docs/DEPLOY.md 里的生成命令） */
async function createVapidKeyPair(): Promise<{ publicKey: string; privateKey: string; cryptoKey: CryptoKey }> {
  const keyPair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
  const jwk = (await (
    crypto.subtle as unknown as { exportKey(format: string, key: CryptoKey): Promise<JsonWebKey> }
  ).exportKey('jwk', keyPair.privateKey)) as JsonWebKey;

  return {
    publicKey: bytesToBase64Url(raw),
    privateKey: String(jwk.d ?? ''),
    cryptoKey: keyPair.publicKey,
  };
}

function fakeEnv(publicKey: string, privateKey: string): VapidConfig {
  return {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
}

describe('encryptPayload（RFC 8291 aes128gcm）', () => {
  it('UA 侧能解密出原始明文', async () => {
    const ua = await createUaKeyPair();
    const plaintext = JSON.stringify({ title: '交周报', body: '还有 1 小时截止', todoId: 't1', kind: '1h' });

    const { body, salt, serverPublicKey } = await encryptPayload(encoder.encode(plaintext), ua.p256dh, ua.auth);

    expect(salt).toHaveLength(16);
    expect(serverPublicKey).toHaveLength(65);
    expect(serverPublicKey[0]).toBe(0x04);
    // header(16+4+1+65) + ciphertext(明文 + 分隔符 1 + GCM tag 16)
    expect(body.length).toBe(86 + encoder.encode(plaintext).length + 1 + 16);

    const decoded = await uaDecrypt(body, ua.uaPrivateKey, ua.uaPublicRaw, ua.authSecret);
    expect(decoded).toBe(plaintext);
  });

  it('每次加密使用不同的 salt 与临时公钥（不可复用）', async () => {
    const ua = await createUaKeyPair();
    const first = await encryptPayload(encoder.encode('a'), ua.p256dh, ua.auth);
    const second = await encryptPayload(encoder.encode('a'), ua.p256dh, ua.auth);

    expect(bytesToBase64Url(first.salt)).not.toBe(bytesToBase64Url(second.salt));
    expect(bytesToBase64Url(first.serverPublicKey)).not.toBe(bytesToBase64Url(second.serverPublicKey));
  });

  it('非法订阅密钥会抛错而不是静默发送', async () => {
    // 首字节不是 0x04（未压缩点标记）
    await expect(
      encryptPayload(encoder.encode('a'), bytesToBase64Url(new Uint8Array(65)), bytesToBase64Url(new Uint8Array(16))),
    ).rejects.toThrow(/不合法/);
    // auth secret 长度不对
    await expect(
      encryptPayload(
        encoder.encode('a'),
        bytesToBase64Url(new Uint8Array(65).fill(4)),
        bytesToBase64Url(new Uint8Array(8)),
      ),
    ).rejects.toThrow(/不合法/);
  });
});

describe('buildVapidAuthorization（RFC 8292）', () => {
  it('生成可被公钥验证的 ES256 JWT', async () => {
    const vapid = await createVapidKeyPair();
    const env = fakeEnv(vapid.publicKey, vapid.privateKey);
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/abc123';

    const authorization = await buildVapidAuthorization(endpoint, env, Date.UTC(2024, 0, 1));
    expect(authorization.startsWith('vapid t=')).toBe(true);
    expect(authorization).toContain(`, k=${vapid.publicKey}`);

    const jwt = authorization.slice('vapid t='.length, authorization.indexOf(', k='));
    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && signatureB64).toBeTruthy();

    // header
    const header = JSON.parse(decoder.decode(base64UrlToBytes(headerB64))) as { alg: string; typ: string };
    expect(header.alg).toBe('ES256');

    // payload：aud 必须是 endpoint 的 origin
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadB64))) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(payload.aud).toBe('https://updates.push.services.mozilla.com');
    expect(payload.sub).toBe('mailto:test@example.com');
    expect(payload.exp).toBe(Math.floor(Date.UTC(2024, 0, 1) / 1000) + 12 * 3600);

    // 签名可用对应公钥验证
    const valid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      vapid.cryptoKey,
      base64UrlToBytes(signatureB64),
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
    expect(valid).toBe(true);
  });

  it('缺少 VAPID_SUBJECT 时明确报错', async () => {
    const vapid = await createVapidKeyPair();
    const env = { ...fakeEnv(vapid.publicKey, vapid.privateKey), VAPID_SUBJECT: '' };
    await expect(buildVapidAuthorization('https://example.com/push', env, Date.now())).rejects.toThrow(/VAPID_SUBJECT/);
  });
});

describe('base64url 编解码', () => {
  it('往返一致，且不含 +/= 字符', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(65));
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
  });
});
