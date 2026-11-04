// Admission control for streamed data, owned by the network worker.
//
// A message may reach the screen only if it comes from the current socket, carries the current
// epoch (the client bumps it on every seek, protocol v2) and is newer than the last sample delivered
// for its topic. Async decoding (images, depth) must check again after the await, because a seek or a
// reconnect can happen while the decoder runs, and decodes can finish out of order.

export class Gate {
  socket = 0;
  epoch = 0;
  private lastT = new Map<number, number>();

  /** A new connection: everything from older sockets is rejected from now on. */
  newSocket(): number {
    this.socket++;
    this.lastT.clear();
    return this.socket;
  }

  /** A seek: returns the new epoch to send to the server. */
  nextEpoch(): number {
    this.epoch++;
    this.lastT.clear();
    return this.epoch;
  }

  /** Cheap check before doing any work on a message. */
  admits(socket: number, epoch: number, topicId: number, t: number): boolean {
    return socket === this.socket && epoch === this.epoch && t > (this.lastT.get(topicId) ?? -Infinity);
  }

  /** Final check right before delivery; records t so older or duplicate samples are dropped later. */
  commit(socket: number, epoch: number, topicId: number, t: number): boolean {
    if (!this.admits(socket, epoch, topicId, t)) return false;
    this.lastT.set(topicId, t);
    return true;
  }
}
