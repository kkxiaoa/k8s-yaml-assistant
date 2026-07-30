class SecretKeyConfigFault extends Error {
  constructor() {
    super('secret key configuration invalid');
    this.name = 'SecretKeyConfigFault';
  }
}

export function decodeBase64Key(
  value: string | undefined,
  bytes = 32,
): Buffer {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    value === undefined ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new SecretKeyConfigFault();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    throw new SecretKeyConfigFault();
  }
  return decoded;
}
