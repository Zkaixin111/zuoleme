/**
 * 与存储相关的常量：页面与 Service Worker 必须共用同一套键名。
 * 单独成文件，避免 Service Worker 为了一个常量把整个 API 客户端打包进来。
 */

/** localStorage 里保存 API Token 的键 */
export const TOKEN_STORAGE_KEY = 'zuoleme:api-token';

/** IndexedDB（kv store）里保存 API Token 的键，供 Service Worker 读取 */
export const IDB_TOKEN_KEY = 'api-token';
