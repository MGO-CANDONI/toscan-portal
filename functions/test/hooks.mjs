const MAP = {
  "firebase-admin/app": "./fakes/app.mjs",
  "firebase-admin/firestore": "./fakes/firestore.mjs",
  "firebase-admin/auth": "./fakes/auth.mjs",
  "firebase-admin/storage": "./fakes/storage.mjs"
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: new URL(MAP[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
