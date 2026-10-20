// The line a session's server writes wait in, so the planner is never run for one session twice at once.
//
// This is the server's form of the browser's `latestAnswer`: per session, one run at a time and at most one waiting run of the
// same kind. A run loads what it needs after it starts, so a request that arrives while another runs is answered by the next
// run, which sees everything the first one did not.
//
// A job is { exclusive?: boolean, settle: { resolve, reject } , ... }, and the queue runs jobs in batches:
//   - Ordinary jobs (a changed start, a suggestion, someone leaving) join the waiting batch if there is one, so a rush of them
//     costs two runs, not one each. The batch's single run does every job's change and one recompute of the spots.
//   - An exclusive job (the host confirming a spot, or setting a known place) is a batch of its own and keeps its turn.
//   - A run that has only recomputed (no job in its batch changed anything itself) and finds an ordinary batch waiting does not
//     write: its jobs move to the waiting batch, which will do the same work with newer inputs, and are answered by it.
//
// How to build and use it (services/sessions.js does this):
//   const queue = createSessionQueue(async (sessionId, batch, { handOver }) => { ...settle every job in batch.jobs... })
//   const answer = await queue.enqueue(sessionId, { exclusive: false, ...job })
//
// The runner must settle every job it is given (job.settle.resolve(value) or job.settle.reject(error)). If it throws, the jobs it
// left unsettled are rejected with that error. `handOver(jobs)` moves those jobs (the ones the runner has not settled) to the
// waiting ordinary batch and answers true, or answers false when there is none (then the runner writes as usual).
export function createSessionQueue(runBatch) {
  const lanes = new Map() // session id -> { running: batch | null, waiting: batch[] }

  // Runs the lane's batches one after another until none is left.
  //
  // How to call (inside this file):
  //   pump(sessionId, lane)
  async function pump(sessionId, lane) {
    try {
      while (lane.waiting.length > 0) {
        const batch = lane.waiting.shift()
        lane.running = batch
        const handOver = (jobs) => {
          const next = lane.waiting[0]
          if (batch.exclusive || !next || next.exclusive) return false
          next.jobs.unshift(...jobs)
          return true
        }
        try {
          await runBatch(sessionId, batch, { handOver })
        } catch (err) {
          for (const job of batch.jobs) job.settle.reject(err)
        } finally {
          lane.running = null
        }
      }
    } finally {
      // The lane is gone once it is idle, so a finished session leaves nothing behind.
      lane.pumping = false
      if (lane.waiting.length === 0) lanes.delete(sessionId)
    }
  }

  return {
    // Adds a job to its session's line. Resolves with what the runner settles the job with.
    //
    // How to call:
    //   const answer = await queue.enqueue(sessionId, { exclusive: false, kind: 'recompute', ... })
    enqueue(sessionId, job) {
      return new Promise((resolve, reject) => {
        const entry = { ...job, settle: { resolve, reject } }
        let lane = lanes.get(sessionId)
        if (!lane) {
          lane = { running: null, waiting: [], pumping: false }
          lanes.set(sessionId, lane)
        }
        const last = lane.waiting.at(-1)
        if (!entry.exclusive && last && !last.exclusive) last.jobs.push(entry)
        else lane.waiting.push({ exclusive: !!entry.exclusive, jobs: [entry] })
        // The first job of an idle lane starts the pump; a lane that is pumping takes the job in its turn.
        if (!lane.pumping) {
          lane.pumping = true
          pump(sessionId, lane)
        }
      })
    },

    // How many sessions have something running or waiting. For tests.
    //
    // How to call:
    //   queue.busy() // 0
    busy: () => lanes.size,

    // How many jobs of one session are waiting for their turn (not the ones running). For tests.
    //
    // How to call:
    //   queue.waiting(sessionId) // 2
    waiting: (sessionId) => lanes.get(sessionId)?.waiting.reduce((n, batch) => n + batch.jobs.length, 0) ?? 0,
  }
}
