import { Router } from 'itty-router'
import { error, status } from 'itty-router-extras'
import { ulid, monotonicFactory, encodeTime } from 'ulid-workers'
import { operations, components } from '@/schema'

export type GetMessagesResponse =
  operations['get-messages']['responses']['200']['content']['application/json']
export type ListQueuesResponse =
  operations['list-queues']['responses']['200']['content']['application/json']
export type PoppedMessage = components['schemas']['PoppedMessage']
export type Message = components['schemas']['Message']
export type QueueModel = components['schemas']['Queue']
export type MessageMetadata = components['schemas']['MessageMetadata']
export type AddMessageRequest =
  operations['create-message']['requestBody']['content']['application/json']

// The monotonic ULID factory produces sequentially increasing ULIDs even if
// they share the same date seed as Date.now in Workers is the time of last IO,
// not the wall clock time.
const nextULID = monotonicFactory()

const router = Router<Request>()

// Create a new queue
router.post<Request>(
  '/queues',
  async (request, state: DurableObjectState, env: Bindings) => {
    const queue_id = request.headers.get('X-NewID')
    if (queue_id) {
      let visibility_timeout: number | undefined
      let name: string | undefined

      try {
        if (request.body) {
          ;({ visibility_timeout, name } = await request.json<QueueModel>())
        }
      } catch (e) {
        // Couldn't parse your JSON there bud, figure it oot.
        return error(400, 'Bad Request')
      }

      const metadata: QueueModel = {
        queue_id,
        visibility_timeout: visibility_timeout ?? 30,
        name,
        created_time: new Date().toISOString(),
      }

      // Store the queue metadata in Workers KV. This will allow us to list queues
      // and read their metadata quickly, in bulk, without having to wake up each
      // Durable Object instance.
      await env.QUEUES_KV.put(`queue:${queue_id}`, queue_id, { metadata })

      return status(201, metadata)
    }

    return error(400, 'Bad Request')
  },
)

router.get(
  '/queues/:queue_id',
  async (request, state: DurableObjectState, { QUEUES_KV }: Bindings) => {
    if (request.params?.queue_id) {
      const queue_kv = await QUEUES_KV.getWithMetadata<QueueModel>(
        `queue:${request.params?.queue_id}`,
      )

      return new Response(JSON.stringify(queue_kv.metadata, null, 2))
    }
    return error(404, 'Not Found')
  },
)

// TODO: properly handle subsequent uses of the DO after deleted. I bet the ID is still good and
// could be used forever, so we want to save some metadata letting us know it's deleted and to
// thrown an error
router.delete(
  '/queues/:queue_id',
  async (
    request,
    state: DurableObjectState,
    env: Bindings,
    deleteObject: Function,
  ) => {
    if (request.params?.queue_id) {
      await state.blockConcurrencyWhile(async () => {
        await env.QUEUES_KV.delete(`queue:${request.params?.queue_id}`)
        await state.storage.deleteAll()
        // It's possible that this queue could recieve requests while we're
        // deleting it. Set a deleted flag to be checked on initialization.
        await state.storage.put('deleted', true) // TODO: Implement this properly
        deleteObject()
      })

      return new Response('OK')
    }
    return error(404, 'Not Found')
  },
)

router.get(
  '/queues/:queue_id/messages',
  async (request, state: DurableObjectState) => {
    const visibility_timeout = request.query?.visibility_timeout
      ? parseInt(request.query?.visibility_timeout)
      : 30 // TODO: make an instance variable currently we're ignore the visibility_timeout set when the queue was created
    const limit = request.query?.limit ? parseInt(request.query?.limit) : 1

    const messages = await state.storage.list<Message>({
      // We encode the current time (the first 10 characters of a ULID) and
      // end our search there. This keeps us from returning our queue's
      // 'metadata' object. It also stops us from returning messages that
      // should remain invisible until sometime in the future because they've
      // already been returned in a different request (visibility timeout).
      end: encodeTime(Date.now() + 10, 10),
      limit,
    })

    // Lets build our response object
    let response: GetMessagesResponse = { messages: [] }

    // Move each message to a key (ULID) seeded with the future time when it
    // should become visible again. This hides the message from other clients
    // until the visibility timeout expires.
    messages.forEach(async (value, key) => {
      // Future time when the messsage should become visible again
      const invisible_until = Date.now() + visibility_timeout * 1000
      // Seed ulid generation with the time when visibility timeout expires
      const pop_receipt = ulid(invisible_until)

      const message: PoppedMessage = {
        ...value,
        pop_receipt,
        visibility_timeout,
      }
      // Add the message to our response body
      response.messages.push(message)
      // Save the message back to DO storage using the future key.
      state.storage.put<PoppedMessage>(pop_receipt, message)
      // Delete the object at the old key
      state.storage.delete(key)
    })

    return new Response(JSON.stringify(response, null, 2))
  },
)

router.post<Request>(
  '/queues/:queue_id/messages',
  async (request, state: DurableObjectState) => {
    if (request.body) {
      let json: AddMessageRequest

      try {
        json = await request?.json<AddMessageRequest>()
      } catch (e) {
        // Couldn't parse your JSON there bud, figure it oot.
        return error(400, 'Bad Request')
      }

      if (json.message_body && request.params?.queue_id) {
        const message_metadata: MessageMetadata = {
          message_id: nextULID(),
          inserted_time: new Date().toISOString(),
          queue_id: request.params?.queue_id,
        }
        await state.storage.put(message_metadata.message_id, {
          ...message_metadata,
          message_body: json.message_body,
        })

        return new Response(JSON.stringify(message_metadata, null, 2), {
          status: 202,
        })
      }
    }
    return error(400, 'Bad Request')
  },
)

router.delete(
  '/queues/:queue_id/messages/:message_id',
  async (request, state: DurableObjectState) => {
    if (request.params?.message_id && request.query?.pop_receipt) {
      const { message_id } = request.params
      const { pop_receipt } = request.query
      const message = await state.storage.get<PoppedMessage>(pop_receipt)
      if (message?.message_id === message_id) {
        state.storage.delete(pop_receipt)
        return new Response('OK')
      }
    }
    return error(400, 'Bad Request')
  },
)

// 400 for everything else
router.all('*', () => new Response('Bad Request.', { status: 400 }))

// 404 for everything else
// router.all('*', () => new Response('Not Found.', { status: 404 }))

export class Queue implements DurableObject {
  state: DurableObjectState
  env: Bindings
  // Typescript doesn't understand this will be initialized in the constructur
  //@ts-ignore
  deleted: Boolean

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state
    this.env = env
    state.blockConcurrencyWhile(async () => {
      this.deleted = (await state.storage.get<Boolean>('deleted')) ?? false
    })
  }

  delete() {
    const deleteFunc = () => (this.deleted = true)
    deleteFunc.bind(this)
    return deleteFunc
  }

  async fetch(request: Request) {
    if (this.deleted) {
      return error(404, 'Not Found')
    }
    return router.handle(request, this.state, this.env, this.delete())
  }
}
