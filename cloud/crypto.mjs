const encoder = new TextEncoder();
export const toBase64Url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function fromBase64Url(text) {
  if(typeof text!=='string'||!/^[A-Za-z0-9_-]*$/.test(text)||text.length>2000000)throw new Error('Invalid encoding');
  return Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
}
export async function sha256Hex(value) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(String(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function hmacSha256(value,secret) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return toBase64Url(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));
}
export function constantTimeEqual(a,b) {if(typeof a!=='string'||typeof b!=='string')return false;let difference=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)difference|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return difference===0;}
async function encryptionKey(secret) {if(typeof secret!=='string'||secret.length<24)throw new Error('Missing encryption key');return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function encryptJson(value,secret) {const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},await encryptionKey(secret),encoder.encode(JSON.stringify(value)));return 'v1.'+toBase64Url(iv)+'.'+toBase64Url(ciphertext);}
export async function decryptJson(value,secret) {if(typeof value!=='string')throw new Error('Invalid protected configuration');const [version,iv,cipher,...extra]=value.split('.');if(version!=='v1'||extra.length)throw new Error('Invalid protected configuration');const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64Url(iv)},await encryptionKey(secret),fromBase64Url(cipher));return JSON.parse(new TextDecoder().decode(raw));}
