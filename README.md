# Durable Objects REST Queue Example

> Note: You must use [wrangler](https://developers.cloudflare.com/workers/cli-wrangler/install-update) 1.19.3 or newer to deploy this project.

An edge queue service that runs on Cloudflare Workers using Durable Objects and KV. It is implemented as a simple REST API.

This demo uses:

- [Cloudflare Workers](https://developers.cloudflare.com/workers/learning/how-workers-works)
- [Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects)
- [KV](https://developers.cloudflare.com/workers/runtime-apis/kv)
- [Miniflare v2](https://v2.miniflare.dev)
- [TypeScript](https://www.typescriptlang.org)
- [Jest](https://jestjs.io)
- [ES Modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
- [esbuild](https://esbuild.github.io)
- [Wrangler](https://developers.cloudflare.com/workers/cli-wrangler/install-update)

## Running the Demo

- `git clone https://github.com/ryan-mars/workers-queue-demo.git`
- Install [wrangler](https://developers.cloudflare.com/workers/cli-wrangler/install-update)
- `cd workers-queue-demo`
- `npm install`
- `wrangler login`
- `wrangler publish` will build, run tests, and deploy to Cloudflare

You should see something like:

```
✨  Build completed successfully!`
✨  Successfully published your script to
 https://workers-queue-demo.you1234.workers.dev
```

> Note the URL 👆🏻

Copy/paste the contents of `schema.yaml` into [Swagger Editor](https://editor.swagger.io/). Change the `servers` key to match your deployed URL.

Have fun!

## Where to find things

- REST API spec is in `schema.yaml`.
- Worker code is in `src/`. The Durable Object `Queue` class is in `src/queue.ts`, and the Worker script is in `src/index.ts`.
- esbuild is configured to output a bundled ES Module to `dist/index.mjs`.
- Unit tests in `src/index.spec.ts`, which will run as part of `wrangler build`. To run tests on their own use `npm test`.
