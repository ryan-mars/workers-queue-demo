import handler from '@/index'
import {
  GetMessagesResponse,
  ListQueuesResponse,
  Message,
  MessageMetadata,
  QueueModel,
} from '@/queue'

declare function getMiniflareBindings(): Bindings
declare function getMiniflareDurableObjectStorage(
  id: DurableObjectId,
): DurableObjectStorage

const THOMAS_PAINE_QUOTE = `THESE are the times that try men's souls. The summer soldier and the sunshine patriot will, in this crisis, shrink from the service of their country; but he that stands by it now, deserves the love and thanks of man and woman. Tyranny, like hell, is not easily conquered; yet we have this consolation with us, that the harder the conflict, the more glorious the triumph.`

let test_queue: QueueModel
beforeEach(async () => {
  // Create a new queue for use in the tests below
  const res: Response = await handler.fetch(
    new Request('https://test/queues/', {
      method: 'POST',
      body: JSON.stringify({ name: 'test queue', visibility_timeout: 10 }),
    }),
    getMiniflareBindings(),
  )

  test_queue = await res.json<QueueModel>()
})

test.todo('responds 500 when things break')

describe('/queues', () => {
  describe('GET', () => {
    let response: Response
    beforeEach(async () => {
      response = await handler.fetch(
        new Request(`https://test/queues`),
        getMiniflareBindings(),
      )
    })
    it('responds 200 for "OK"', async () => {
      expect(response.status).toBe(200)
    })
    it('response matches the spec', async () => {
      const json = await response.json<ListQueuesResponse>()
      expect(json).toMatchObject<ListQueuesResponse>({
        queues: [
          {
            queue_id: test_queue.queue_id,
            created_time: expect.any(String),
            name: 'test queue',
            visibility_timeout: 10,
          },
        ],
      })
    })
    describe('pagination', () => {
      beforeAll(async () => {
        // Create 1,001 queues
        const promises = Array(1001)
          .fill(undefined)
          .map((i) =>
            handler.fetch(
              new Request(`https://test/queues`, { method: 'POST' }),
              getMiniflareBindings(),
            ),
          )
        await Promise.all(promises)
      })
      it('returns a cursor when paginating results', async () => {
        response = await handler.fetch(
          new Request(`https://test/queues`),
          getMiniflareBindings(),
        )
        const json = await response.json<ListQueuesResponse>()

        expect(json.queues.length).toBe(1000)
        expect(json.cursor).toStrictEqual(expect.any(String))
      })
      it('returns the next page of results with the cursor', async () => {
        response = await handler.fetch(
          new Request(`https://test/queues`),
          getMiniflareBindings(),
        )
        const { cursor } = await response.json<ListQueuesResponse>()
        response = await handler.fetch(
          new Request(`https://test/queues?cursor=${cursor}`),
          getMiniflareBindings(),
        )
        const json = await response.json<ListQueuesResponse>()
        // There's two more even though we created 1,001 because of `test_queue`
        // created in the `beforeEach` for all tests
        expect(json.queues.length).toBe(2)
      })
    })
  })
  describe('POST', () => {
    it('response 201 for "Created"', async () => {
      expect(test_queue).toMatchObject({
        queue_id: test_queue.queue_id,
        name: 'test queue',
        visibility_timeout: 10,
        created_time: expect.any(String),
      })
    })
    it('stores queue metadata in KV', async () => {
      let { QUEUES_KV } = getMiniflareBindings()

      const queue_kv = await QUEUES_KV.getWithMetadata<QueueModel>(
        `queue:${test_queue.queue_id}`,
      )

      expect(queue_kv.metadata).toStrictEqual(test_queue)
    })
  })
})
describe('/queues/{queue_id}', () => {
  describe('GET', () => {
    it('responds 200 for "OK"', async () => {
      const res: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}`),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(200)
    })
    it('response matches the spec', async () => {
      const res: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}`),
        getMiniflareBindings(),
      )
      const json = await res.json<QueueModel>()
      expect(json).toMatchObject({
        queue_id: test_queue.queue_id,
        name: 'test queue',
        visibility_timeout: 10,
        created_time: expect.any(String),
      })
    })
    it('responds 404 for "Not Found"', async () => {
      const res: Response = await handler.fetch(
        new Request(`https://test/queues/NO_SUCH_QUEUE`),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(404)
    })
  })
  describe('DELETE', () => {
    let response: Response
    beforeEach(async () => {
      // TODO: Use Promise.all instead
      const messages = ['every', 'good', 'boy', 'does', 'fine']
      for (const message_body of messages) {
        await handler.fetch(
          new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              message_body,
            }),
          }),
          getMiniflareBindings(),
        )
      }
      response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}`, {
          method: 'DELETE',
        }),
        getMiniflareBindings(),
      )
    })
    it('responds 200 for "OK"', async () => {
      expect(response.status).toBe(200)
    })
    it('removes the queue and messages', async () => {
      const { QUEUES_KV, QUEUE } = getMiniflareBindings()
      const value = await QUEUES_KV.get(test_queue.queue_id)
      const id = QUEUE.idFromName(test_queue.queue_id)
      const storage = await getMiniflareDurableObjectStorage(id)
      const items = await storage.list()
      expect(items.size).toBe(1)
      expect(items.get('deleted')).toBeTruthy()
      expect(value).toBeFalsy()
    })
    it('responds 404 for "Not Found" for subsequent requests', async () => {
      const response: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message_body: 'test',
          }),
        }),
        getMiniflareBindings(),
      )
      expect(response.status).toBe(404)
    })
  })
})
describe('/queues/{queue_id}/messages', () => {
  describe('GET', () => {
    beforeEach(async () => {
      // Start us out with five messages, in order
      const messages = ['every', 'good', 'boy', 'does', 'fine']
      for (const message_body of messages) {
        await handler.fetch(
          new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              message_body,
            }),
          }),
          getMiniflareBindings(),
        )
      }
    })
    it('responds 200 for "OK"', async () => {
      const res: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(200)
    })
    it('returns visible messages', async () => {
      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages?limit=10`,
        ),
        getMiniflareBindings(),
      )

      const json = await res.json<GetMessagesResponse>()

      expect(json.messages.length).toBe(5)
    })
    it('limits the response size', async () => {
      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages?limit=2`,
        ),
        getMiniflareBindings(),
      )

      const json = await res.json<GetMessagesResponse>()

      expect(json.messages.length).toBe(2)
    })
    it('overrides the queues visibility timeout', async () => {
      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages?visibility_timeout=69&limit=10`,
        ),
        getMiniflareBindings(),
      )
      const json = await res.json<GetMessagesResponse>()
      expect(
        json.messages.map((message) => message.visibility_timeout),
      ).toEqual([69, 69, 69, 69, 69])
    })
    it('hides returned messages for the visibility_timeout', async () => {
      await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages?limit=1`,
        ),
        getMiniflareBindings(),
      )

      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages?limit=10`,
        ),
        getMiniflareBindings(),
      )
      const json = await res.json<GetMessagesResponse>()
      expect(json.messages.length).toBe(4)
    })
    it.todo('does not return messages with expired ttl')
    it.todo('responds 400 for "Bad Request"') // visibility timeout too high
    it.todo('responds 404 for "Not Found"')
  })
  describe('POST', () => {
    it('responds 202 for "Accepted"', async () => {
      const res: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message_body: THOMAS_PAINE_QUOTE,
          }),
        }),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(202)
    })
    it('adds a message to the queue', async () => {
      const addMessageResponse: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message_body: THOMAS_PAINE_QUOTE,
          }),
        }),
        getMiniflareBindings(),
      )

      const { message_id } = await addMessageResponse.json<{
        message_id: string
      }>()

      let { QUEUE } = getMiniflareBindings()
      const id = QUEUE.idFromName(test_queue.queue_id)

      const storage = await getMiniflareDurableObjectStorage(id)
      const items = await storage.list()

      expect(items.get(message_id)).toMatchObject({
        message_id,
        message_body: THOMAS_PAINE_QUOTE,
      })
    })
    it('matches the spec', async () => {
      const addMessageResponse: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message_body: THOMAS_PAINE_QUOTE,
          }),
        }),
        getMiniflareBindings(),
      )

      expect(await addMessageResponse.json<MessageMetadata>()).toEqual(
        expect.objectContaining<MessageMetadata>({
          queue_id: expect.any(String),
          message_id: expect.any(String),
          inserted_time: expect.any(String),
        }),
      )
    })
    it('responds 400 for "Bad Request"', async () => {
      const noMessageRes: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        getMiniflareBindings(),
      )
      expect(noMessageRes.status).toBe(400)

      const noBodyRes: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
        }),
        getMiniflareBindings(),
      )
      expect(noBodyRes.status).toBe(400)
      expect(noBodyRes.statusText)
    })
    it('responds 404 for "Not Found"', async () => {
      const res: Response = await handler.fetch(
        new Request(`https://test/queues/DOES_NOT_EXIST/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message_body: THOMAS_PAINE_QUOTE,
          }),
        }),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(404)
    })
  })
})
describe('/queues/{queue_id}/messages/{message_id}', () => {
  describe('DELETE', () => {
    let message_id: string
    let pop_receipt: string

    beforeEach(async () => {
      // Add a message
      await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message_body: THOMAS_PAINE_QUOTE,
          }),
        }),
        getMiniflareBindings(),
      )

      // Get the message back off the queue
      const getMessagesRes: Response = await handler.fetch(
        new Request(`https://test/queues/${test_queue.queue_id}/messages`),
        getMiniflareBindings(),
      )
      const json = await getMessagesRes.json<GetMessagesResponse>()
      ;({ message_id, pop_receipt } = json.messages[0])
    })
    it('responds 200 for "OK"', async () => {
      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages/${message_id}?pop_receipt=${pop_receipt}`,
          { method: 'DELETE' },
        ),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(200)
    })
    it('deletes the message', async () => {
      // Delete it
      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages/${message_id}?pop_receipt=${pop_receipt}`,
          { method: 'DELETE' },
        ),
        getMiniflareBindings(),
      )

      // Pull everything from storage and verify there are no messages at all
      // I feel like this is a better test than just checking if the one item
      // has been deleted
      let { QUEUE } = getMiniflareBindings()
      const id = QUEUE.idFromName(test_queue.queue_id)
      const storage = await getMiniflareDurableObjectStorage(id)
      const items = await storage.list()
      // The only thing left in storage should be the metadata record
      expect([...items.keys()]).toEqual([])
    })
    it('responds 400 for "Bad Request"', async () => {
      const res: Response = await handler.fetch(
        new Request(
          `https://test/queues/${test_queue.queue_id}/messages/WRONG?pop_receipt=WRONGs`,
          { method: 'DELETE' },
        ),
        getMiniflareBindings(),
      )
      expect(res.status).toBe(400)
    })
  })
})
