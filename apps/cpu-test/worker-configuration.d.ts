// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface Env {}

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
