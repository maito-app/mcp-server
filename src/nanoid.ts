// Минимальный nanoid для генерации IDs — без зависимости.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export function nanoid(size = 21): string {
  let id = '';
  const bytes = new Uint8Array(size);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < size; i++) id += alphabet[bytes[i] & 63];
  return id;
}
