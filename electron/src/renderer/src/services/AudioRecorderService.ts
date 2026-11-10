// AudioRecorderService wraps MediaRecorder for push-to-talk audio capture.

type StopCallback = { resolve: (blob: Blob) => void; reject: (err: Error) => void }

export class AudioRecorderService {
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private stream: MediaStream | null = null

  // Incremented to invalidate stale async continuations (pending getUserMedia, ondataavailable).
  private currentGeneration = 0

  // Holds all resolve/reject pairs waiting for the current stop to complete.
  // null means no stop is in progress. Multiple stopRecording() calls share this array
  // so each promise settles exactly once alongside the first caller.
  private pendingStopCallbacks: StopCallback[] | null = null

  async startRecording(): Promise<void> {
    // A1: guard BEFORE generation increment so a duplicate start() call while recording
    // is active does NOT invalidate the active recorder's ondataavailable gate.
    if (this.mediaRecorder !== null) {
      console.warn('[AudioRecorderService] recording already in progress — ignoring start')
      return
    }

    const myGeneration = ++this.currentGeneration

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch (err) {
      // A1 cont.: getUserMedia may fail after cancelRecording() already incremented the
      // generation. In that case, discard silently — the session was already cancelled.
      if (myGeneration !== this.currentGeneration) return
      throw err
    }

    // A7 cont.: cancelRecording() increments currentGeneration before checking mediaRecorder,
    // so a pending getUserMedia() is always invalidated even when no recorder exists yet.
    if (myGeneration !== this.currentGeneration) {
      stream.getTracks().forEach(t => t.stop())
      return
    }

    this.stream = stream
    this.audioChunks = []
    const recorder = new MediaRecorder(this.stream)
    this.mediaRecorder = recorder

    // A2: generation gate prevents a final buffered chunk from a cancelled recorder
    // from landing in a subsequent recording's audioChunks array.
    recorder.ondataavailable = (event: BlobEvent) => {
      if (this.currentGeneration !== myGeneration) return
      if (event.data.size > 0) this.audioChunks.push(event.data)
    }

    // onerror: handles recording failures (hardware disconnect, codec error, etc.).
    // Rejects any pending stop() promises and releases resources immediately rather
    // than waiting for a later cancelRecording() call.
    recorder.onerror = () => {
      if (this.currentGeneration !== myGeneration) return  // stale recorder
      recorder.onstop = null
      const callbacks = this.pendingStopCallbacks
      this.pendingStopCallbacks = null
      console.error('[AudioRecorderService] MediaRecorder error — cleaning up')
      this.cleanup()
      if (callbacks !== null) {
        const err = new Error('[AudioRecorderService] MediaRecorder error')
        callbacks.forEach(cb => cb.reject(err))
      }
    }

    recorder.start(100)
    console.log('[AudioRecorderService] recording started')
  }

  stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const recorder = this.mediaRecorder

      if (recorder === null) {
        // Invalidate any pending getUserMedia() — stop() without an active recorder
        // indicates the session state machine is ahead of the audio lifecycle.
        this.currentGeneration++
        reject(new Error('[AudioRecorderService] no active recorder to stop'))
        return
      }

      // A3: check pending BEFORE inactive. MediaRecorder.stop() transitions state to
      // 'inactive' synchronously, so by the time a second call arrives the recorder may
      // already be inactive even though a stop is in flight. If we checked inactive first,
      // cleanup() would clear audioChunks and onstop would resolve the first caller with
      // an empty blob. Joining the pending array keeps both callers on the same outcome.
      if (this.pendingStopCallbacks !== null) {
        this.pendingStopCallbacks.push({ resolve, reject })
        return
      }

      // A6: recorder may have gone inactive due to a recording error. Calling stop()
      // on an inactive recorder throws InvalidStateError and leaks the stream.
      if (recorder.state === 'inactive') {
        this.cleanup()
        reject(new Error('[AudioRecorderService] recorder already inactive'))
        return
      }

      this.pendingStopCallbacks = [{ resolve, reject }]

      recorder.onstop = () => {
        if (this.pendingStopCallbacks === null) return  // already handled by onerror or cancel
        const callbacks = this.pendingStopCallbacks
        this.pendingStopCallbacks = null
        recorder.onerror = null  // prevent spurious onerror after a clean stop
        // A5: use local `recorder` reference — this.mediaRecorder is null after cleanup()
        const audioBlob = new Blob(this.audioChunks, { type: recorder.mimeType })
        console.log(
          `[AudioRecorderService] recording stopped — ${(audioBlob.size / 1024).toFixed(1)} KB`
        )
        this.cleanup()
        callbacks.forEach(cb => cb.resolve(audioBlob))
      }

      try {
        recorder.stop()
      } catch (err) {
        // Synchronous stop() error (e.g. unexpected state transition between the inactive
        // check above and the stop() call). Clean up and reject all waiting callers.
        const error = err instanceof Error ? err : new Error(String(err))
        this.pendingStopCallbacks = null
        recorder.onstop = null
        this.cleanup()
        reject(error)
      }
    })
  }

  cancelRecording(): void {
    // A7: increment BEFORE the null check so a pending getUserMedia() is always
    // invalidated — even when mediaRecorder is still null at the time of cancellation.
    this.currentGeneration++

    const callbacks = this.pendingStopCallbacks
    this.pendingStopCallbacks = null

    if (this.mediaRecorder !== null) {
      this.mediaRecorder.onstop = null
      this.mediaRecorder.onerror = null
      // A4: guard against calling stop() on an already inactive recorder (throws InvalidStateError)
      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop()
      }
      this.cleanup()
    }

    // A3: reject any promises that were waiting for the stop to complete
    if (callbacks !== null) {
      const err = new Error('[AudioRecorderService] recording cancelled')
      callbacks.forEach(cb => cb.reject(err))
    }

    console.log('[AudioRecorderService] recording cancelled')
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.mediaRecorder = null
    this.audioChunks = []
  }
}
