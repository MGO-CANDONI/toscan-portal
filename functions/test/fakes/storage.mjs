export const files = new Map(); // path -> {size, contentType}
export function getStorage() {
  return { bucket: () => ({ file: path => ({
    async exists() { return [files.has(path)]; },
    async getMetadata() { return [files.get(path)]; },
    async delete() { files.delete(path); }
  }) }) };
}
