import { Client as WSClient } from 'rpc-websockets'
import { Message } from 'google-protobuf'
// import wretch from 'wretch'

import { ContractMethodCall } from './proto/loom_pb'
import { Uint8ArrayToB64, B64ToUint8Array, bytesToHexAddr } from './crypto-utils'
import { Address } from './address'

interface ITxHandlerResult {
  code: number
  log?: string // error message if code != 0
  data?: string
}

interface IBroadcastTxCommitResult {
  check_tx: ITxHandlerResult
  deliver_tx: ITxHandlerResult
  hash: string
  height: string // int64
}

/**
 * Middleware handlers are expected to transform the input data and return the result.
 * Handlers should not modify the original input data in any way.
 */
export interface ITxMiddlewareHandler {
  Handle(txData: Readonly<Uint8Array>): Promise<Uint8Array>
}

interface IRPCClientOptions {
  autoConnect?: boolean
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnects?: number
  generateRequestId?: (method: string, params: object | any[]) => string | number
}

class RPCClient {
  private _client: WSClient
  private _openPromise?: Promise<void>

  constructor(public url: string, opts: IRPCClientOptions = {}) {
    this._client = new WSClient(url, {
      autoconnect: opts.autoConnect,
      reconnect: opts.reconnect,
      reconnect_interval: opts.reconnectInterval,
      max_reconnects: opts.maxReconnects
    })
  }

  private _ensureConnectionAsync(): Promise<void> {
    if (this._client.ready) {
      return Promise.resolve()
    }
    if (!this._openPromise) {
      this._openPromise = new Promise((resolve, reject) => {
        this._client.on('open', () => resolve())
        this._client.on('error', err => {
          console.log(err)
          reject(err)
        })
      })
    }
    return this._openPromise
  }

  async sendAsync<T>(method: string, params: object | any[]): Promise<T> {
    await this._ensureConnectionAsync()
    return this._client.call<T>(method, params)
  }
}

/**
 * Writes to & reads from a Loom DAppChain.
 */
export class Client {
  public readonly chainId: string
  private _writeClient: RPCClient
  private _readClient: RPCClient

  txMiddleware: ITxMiddlewareHandler[] = []

  /**
   * Constructs a new client to read & write data from/to a Loom DAppChain.
   * @param chainId DAppChain identifier.
   * @param writeUrl Host & port to send txs, specified as "<protocoL>://<host>:<port>".
   * @param readUrl Host & port of the DAppChain read/query interface.
   */
  constructor(chainId: string, writeUrl: string, readUrl?: string) {
    this.chainId = chainId
    // TODO: basic validation of the URIs to ensure they have all required components.
    this._writeClient = new RPCClient(writeUrl)
    if (!readUrl || writeUrl === readUrl) {
      this._readClient = this._writeClient
    } else {
      this._readClient = new RPCClient(readUrl)
    }
  }

  /**
   * Commits a transaction to the DAppChain.
   *
   * @param tx Transaction to commit.
   * @returns Result (if any) returned by the tx handler in the contract that processed the tx.
   */
  async commitTxAsync<T extends Message>(tx: T): Promise<Uint8Array | void> {
    let txBytes = tx.serializeBinary()
    for (let i = 0; i < this.txMiddleware.length; i++) {
      txBytes = await this.txMiddleware[i].Handle(txBytes)
    }
    const payload = Uint8ArrayToB64(txBytes)
    const result = await this._writeClient.sendAsync<IBroadcastTxCommitResult>(
      'broadcast_tx_commit',
      [payload]
    )
    if (result) {
      if (result.check_tx.code != 0) {
        if (!result.check_tx.log) {
          throw new Error(`Failed to commit Tx: ${result.check_tx.code}`)
        }
        throw new Error(`Failed to commit Tx: ${result.check_tx.log}`)
      }
      if (result.deliver_tx.code != 0) {
        if (!result.deliver_tx.log) {
          throw new Error(`Failed to commit Tx: ${result.deliver_tx.code}`)
        }
        throw new Error(`Failed to commit Tx: ${result.deliver_tx.log}`)
      }
    }
    if (result.deliver_tx.data) {
      return B64ToUint8Array(result.deliver_tx.data)
    }
  }

  /**
   * Queries the current state of a contract.
   */
  async queryAsync(contract: Address, query?: Message): Promise<Uint8Array | void> {
    const result = await this._readClient.sendAsync<string>('query', {
      contract: contract.local.toString(),
      query: query ? query.serializeBinary() : undefined
    })
    if (result) {
      return B64ToUint8Array(result)
    }
  }

  /**
   * Gets a nonce for the given public key.
   *
   * @param key A hex encoded public key.
   * @return The nonce.
   */
  getNonceAsync(key: string): Promise<number> {
    return this._readClient.sendAsync<number>('nonce', { key })
  }
}