/**
 * Web Push 协议实现（RFC 8291 aes128gcm + RFC 8292 VAPID）。
 *
 * 为什么自己写而不引 npm 包：Workers 原生支持 ECDH P-256 / HKDF / AES-128-GCM /
 * ECDSA P-256，手写约 150 行即可，零依赖、无打包兼容风险。
 * 整个流程已由 tests/webpush.test.ts 做收发闭环验证（模拟 UA 侧解密）。
 */

import type { PushPayload } from '../../shared/types';
import type { VapidConfig } from './vapid';

const encoder = new TextEncoder();

/**
 * Workers 的 `crypto.subtle` 类型定义对部分参数描述不完整
 * （例如 JWK 导入、ECDH 的 `public` 字段名），而运行时行为与浏览器 WebCrypto 完全一致。
 * 这里做一层窄化适配，避免在每处调用点写类型断言。
 */
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
  encrypt(algorithm: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algorithm: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
};

/** aes128gcm 单条记录大小（rs），必须 >= 18 且不超过 UA 支持上限 */
const RECORD_SIZE = 4096;

/** 推送体最大 TTL（24 小时） */
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * base64url 字符串 → 字节数组。
 *
 * @param input base64url（可带或不带 padding）
 */
export function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 字节数组 → base64url（无 padding）。
 *
 * @param bytes 原始字节
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 拼接多个字节数组 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 32 位大端整数 */
function uint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, false);
  return buf;
}

/** HKDF-SHA256（extract + expand），WebCrypto 一步完成 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  lengthInBytes: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthInBytes * 8,
  );
  return new Uint8Array(bits);
}

/** 导入用户代理（浏览器）的 p256dh 公钥 */
async function importUaPublicKey(p256dh: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(p256dh);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('订阅公钥 p256dh 不合法（应为 65 字节未压缩 P-256 点）');
  }
  return await subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export interface EncryptOptions {
  /** 测试注入：固定 salt，生产环境随机 */
  salt?: Uint8Array;
  /** 测试注入：固定临时密钥对，生产环境每次随机生成 */
  keyPair?: CryptoKeyPair;
}

export interface EncryptedMessage {
  /** 完整的 aes128gcm 请求体（header + ciphertext） */
  body: Uint8Array;
  /** 本次使用的 salt（调试用） */
  salt: Uint8Array;
  /** 本次使用的应用服务器公钥（调试用） */
  serverPublicKey: Uint8Array;
}

/**
 * 加密一条推送消息（RFC 8291 §3 aes128gcm 编码）。
 *
 * @param plaintext 明文（通常是 JSON 字符串的 UTF-8）
 * @param p256dh 订阅方的 P-256 公钥（base64url，未压缩点）
 * @param authSecret 订阅方的 auth secret（base64url，16 字节）
 * @param options 测试用的确定性注入
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  options: EncryptOptions = {},
): Promise<EncryptedMessage> {
  const uaPublicRaw = base64UrlToBytes(p256dh);
  const authBytes = base64UrlToBytes(authSecret);
  if (uaPublicRaw.length !== 65) {
    throw new Error('订阅公钥 p256dh 长度不合法');
  }
  if (authBytes.length !== 16) {
    throw new Error('订阅 auth secret 长度不合法（应为 16 字节）');
  }

  const uaPublicKey = await importUaPublicKey(p256dh);
  const ephemeralKeyPair =
    options.keyPair ??
    ((await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);

  // 1. ecdh_secret = ECDH(as_private, ua_public)
  const ecdhSecret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, ephemeralKeyPair.privateKey, 256),
  );

  // 2. as_public = 未压缩点（65 字节），用于写入消息头
  const asPublicRaw = new Uint8Array(await subtle.exportKey('raw', ephemeralKeyPair.publicKey));

  // 3. IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concatBytes([encoder.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw]);
  const ikm = await hkdf(authBytes, ecdhSecret, keyInfo, 32);

  // 4. CEK / NONCE
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // 5. AES-128-GCM 加密（明文尾部追加 0x02 作为最后一条记录的分隔符）
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concatBytes([plaintext, new Uint8Array([0x02])]);
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record),
  );

  // 6. header = salt(16) || rs(4) || idlen(1) || as_public(65)
  const header = concatBytes([salt, uint32BE(RECORD_SIZE), new Uint8Array([asPublicRaw.length]), asPublicRaw]);

  return {
    body: concatBytes([header, ciphertext]),
    salt,
    serverPublicKey: asPublicRaw,
  };
}

/**
 * 生成 VAPID 鉴权头（RFC 8292）。
 *
 * @param endpoint 订阅 endpoint（取其 origin 作为 aud）
 * @param env 运行环境（提供 VAPID 密钥）
 * @param now 当前时间（毫秒），用于 exp
 */
export async function buildVapidAuthorization(endpoint: string, env: VapidConfig, now: number): Promise<string> {
  const audience = new URL(endpoint).origin;
  if (!env.VAPID_SUBJECT) {
    throw new Error('缺少 VAPID_SUBJECT secret');
  }

  const publicKeyBytes = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY 不合法（应为 65 字节未压缩 P-256 点）');
  }

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    // VAPID 规定 exp 不得超过 24 小时，这里取 12 小时
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT,
  };

  const signingInput = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  )}`;

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(publicKeyBytes.subarray(1, 33)),
    y: bytesToBase64Url(publicKeyBytes.subarray(33, 65)),
    d: env.VAPID_PRIVATE_KEY.replace(/=+$/, ''),
    ext: true,
  };

  const signingKey = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto 的 ECDSA 签名输出即 r||s（P1363），与 JWS ES256 要求一致
  const signature = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encoder.encode(signingInput)),
  );

  const jwt = `${signingInput}.${bytesToBase64Url(signature)}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

export interface WebPushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * 组装一次 Web Push 请求（加密 + VAPID 头）。
 *
 * @param env 运行环境
 * @param subscription 订阅信息（endpoint + keys）
 * @param payload 推送体
 * @param now 当前时间（毫秒）
 * @param ttlSeconds TTL，默认 24 小时
 */
export async function buildPushRequest(
  env: VapidConfig,
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
  now: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<WebPushRequest> {
  const plaintext = encoder.encode(JSON.stringify(payload));
  const { body } = await encryptPayload(plaintext, subscription.p256dh, subscription.auth);
  const authorization = await buildVapidAuthorization(subscription.endpoint, env, now);

  return {
    endpoint: subscription.endpoint,
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
      // high：让 UA 尽量立即投递
      Urgency: 'high',
    },
    body,
  };
}
