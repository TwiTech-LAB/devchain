// Placeholder — @fastify/http-proxy wsClientOptions.rewriteRequestHeaders type gap.
// The runtime accepts the callback but upstream types don't declare it.
// A targeted @ts-expect-error is used at the call site instead of module
// augmentation because the complex intersection types
// (FastifyHttpProxyOptions & WebsocketOptionsEnabled) make clean augmentation
// impractical. Remove when @fastify/http-proxy types fix this upstream.
export {};
