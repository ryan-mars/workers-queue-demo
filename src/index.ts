export { Queue } from '@/queue'
import { ListQueuesResponse, QueueModel } from '@/queue'
import { Router } from 'itty-router'
import { monotonicFactory } from 'ulid-workers'

// ULIDs are Universally Unique Lexicographically Sortable Identifiers.
// This will come in handy with message storage/sorting/retreival, as you'll
// see in the Durable Object.
// You can learn more about ULID here https://github.com/ulid/spec
const ulid = monotonicFactory()

// Create a router (note the lack of "new")
const router = Router()

// Respond to CORS preflight (i.e. from Swagger)
router.options<Request>(
  '*',
  (request) =>
    new Response(null, {
      headers: {
        // Allow requests from anywhere. DO NOT DO THIS IN PRODUCTION
        'Access-Control-Allow-Origin':
          // the browsers stated origin, otherwise this url
          request.headers.get('origin') ?? new URL(request.url).origin,
        // HTTP methods this server allows
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        // HTTP headers this server allows
        'Access-Control-Allow-Headers': [
          'Origin',
          'X-Requested-With',
          'content-type',
          'Accept',
        ].join(','),
      },
    }),
)

// List queues
router.get<Request>('/queues', async (request, { QUEUES_KV }: Bindings) => {
  const response: ListQueuesResponse = { queues: [] }
  const cursor = request.query?.cursor
  const queues = await QUEUES_KV.list<QueueModel>({
    prefix: 'queue:',
    cursor,
  })
  response.cursor = queues.cursor
  response.queues = queues.keys.map((key) => key.metadata!)

  return new Response(JSON.stringify(response, null, 2), {
    headers: {
      // Allow requests from anywhere. DO NOT DO THIS IN PRODUCTION
      'Access-Control-Allow-Origin':
        // the browsers stated origin, otherwise this url
        request.headers.get('origin') ?? new URL(request.url).origin,
    },
  })
})

// Route for a new queue
// First, generate a new Id for the new queue and route the request to the new Durable Object instance
router.post<Request>('/queues', async (request: Request, env: Bindings) => {
  const queue_id = ulid()
  // Generate the Durable Object Id for this queue's ULID
  const id = env.QUEUE.idFromName(queue_id)
  // Get *the* instace of the queue's Durable Object
  const stub = env.QUEUE.get(id)
  const requestWithNewHeader = new Request(request)
  // We need to let the new queue know it's own (customer facing) Id, it doesn't
  // feel right to modify the request body so we'll pass it to the durable object
  // in a header. There's probably a more elegant way to do this...
  // We should probably throw an error if this header already exists on the
  // incoming reuquest, in case someone is fuzzing our API. Not going to mess
  // with that for now.
  requestWithNewHeader.headers.set('X-NewID', queue_id)

  let response = await stub.fetch(requestWithNewHeader)
  response = new Response(response.body, response)
  // Let any client connect by returning the client's stated origin in
  // the CORS header. DO NOT DO THIS IN PRODUCTION
  response.headers.set(
    'Access-Control-Allow-Origin',
    request.headers.get('origin') ?? new URL(request.url).origin,
  )
  return response
})

// All routes destined for an individual queue
router.all<Request>(
  '/queues/:queue_id/?*',
  async function (request, env: Bindings) {
    // Get the queue id supplied in the URL
    const queue_id = request.params?.queue_id
    if (queue_id) {
      // Check that the queue exists and was not previously deleted
      const exists = await env.QUEUES_KV.get(`queue:${queue_id}`)
      if (exists) {
        // Get the Durable Object Id for this queue's ULID
        const id = env.QUEUE.idFromName(queue_id)
        // Get *the* instace of the Queue's Durable Object
        const stub = env.QUEUE.get(id)
        // Forward the request and return the response
        let response = await stub.fetch(request)
        response = new Response(response.body, response)
        // Let any client connect by returning the client's stated origin in
        // the CORS header (for Swagger Hub)
        response.headers.set(
          'Access-Control-Allow-Origin',
          request.headers.get('origin') ?? new URL(request.url).origin,
        )
        return response
      }
    }
    // Otherwise we can't find the queue, return a 404.
    return new Response('Not Found.', {
      status: 404,
      headers: {
        // Let any client connect by returning the client's stated origin in
        // the CORS header. DO NOT DO THIS IN PRODUCTION
        'Access-Control-Allow-Origin':
          request.headers.get('origin') ?? new URL(request.url).origin,
      },
    })
  },
)
// 404 for everything else
router.all<Request>(
  '*',
  (request) =>
    new Response('Not Found.', {
      status: 404,
      headers: {
        // Let any client connect by returning the client's stated origin in
        // the CORS header. DO NOT DO THIS IN PRODUCTION
        'Access-Control-Allow-Origin':
          request.headers.get('origin') ?? new URL(request.url).origin,
      },
    }),
)

// TODO: Explain this
export default {
  fetch: router.handle,
}
