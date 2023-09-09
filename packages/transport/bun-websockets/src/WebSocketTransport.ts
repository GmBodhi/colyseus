/// <reference types="bun-types" />
import Bun, { ServeOptions, ServerWebSocket, WebSocketHandler } from "bun";

import http from 'http';
import querystring from 'querystring';

import { DummyServer, ErrorCode, matchMaker, Transport, debugAndPrintError, spliceOne } from '@colyseus/core';
import { WebSocketClient, WebSocketWrapper } from './WebSocketClient';

export type TransportOptions = Partial<Omit<WebSocketHandler, "message" | "open" | "drain" | "close" | "ping" | "pong">>;

interface WebSocketData {
  url: URL;
  // query: string,
  // headers: { [key: string]: string },
  // connection: { remoteAddress: string },
}

export class uWebSocketsTransport extends Transport {
  public bunServer: Bun.Server;

  protected clients: ServerWebSocket<WebSocketData>[] = [];
  protected clientWrappers = new WeakMap<ServerWebSocket<WebSocketData>, WebSocketWrapper>();

  private _listeningSocket: any;

  constructor(private options: TransportOptions = {}) {
    super();

    // Adding a mock object for Transport.server
    if (!this.server) {
      this.server = new DummyServer();
    }

    this.registerMatchMakeRequest();
  }

  public listen(port: number | string, hostname?: string, backlog?: number, listeningListener?: () => void) {
    this.bunServer = Bun.serve<WebSocketData>({
      port,
      hostname,

      fetch(req, server) {
        // req.headers.get("Cookie");
        const url = new URL(req.url);

        server.upgrade(req, {
          data: { url, },
        });

        // TODO: handle http requests

        return undefined;
      },

      websocket: {
        ...this.options,

        async open(ws) {
          await this.onConnection(ws);
        },

        message(ws, message) {
          // this.clientWrappers.get(ws)?.emit('message', Buffer.from(message.slice(0)));
          this.clientWrappers.get(ws)?.emit('message', message);
        },

        close(ws, code, reason) {
          // remove from client list
          spliceOne(this.clients, this.clients.indexOf(ws));

          const clientWrapper = this.clientWrappers.get(ws);
          if (clientWrapper) {
            this.clientWrappers.delete(ws);

            // emit 'close' on wrapper
            clientWrapper.emit('close', code);
          }
        },

      }
    });

    listeningListener?.();
    this.server.emit("listening"); // Mocking Transport.server behaviour, https://github.com/colyseus/colyseus/issues/458

    return this;
  }

  public shutdown() {
    if (this._listeningSocket) {
      this.bunServer.stop(true);
      this.server.emit("close"); // Mocking Transport.server behaviour, https://github.com/colyseus/colyseus/issues/458
    }
  }

  public simulateLatency(milliseconds: number) {
    const originalRawSend = WebSocketClient.prototype.raw;
    WebSocketClient.prototype.raw = function () {
      setTimeout(() => originalRawSend.apply(this, arguments), milliseconds);
    }
  }

  protected async onConnection(rawClient: ServerWebSocket<WebSocketData>) {
    const wrapper = new WebSocketWrapper(rawClient);
    // keep reference to client and its wrapper
    this.clients.push(rawClient);
    this.clientWrappers.set(rawClient, wrapper);

    const parsedURL = new URL(rawClient.data.url);

    const sessionId = parsedURL.searchParams.get("sessionId");
    const processAndRoomId = parsedURL.pathname.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/);
    const roomId = processAndRoomId && processAndRoomId[1];

    const room = matchMaker.getRoomById(roomId);
    const client = new WebSocketClient(sessionId, wrapper);

    //
    // TODO: DRY code below with all transports
    //

    try {
      if (!room || !room.hasReservedSeat(sessionId, parsedURL.searchParams.get("reconnectionToken") as string)) {
        throw new Error('seat reservation expired.');
      }

      await room._onJoin(client, rawClient as unknown as http.IncomingMessage);

    } catch (e) {
      debugAndPrintError(e);

      // send error code to client then terminate
      client.error(e.code, e.message, () => rawClient.close());
    }
  }

  protected registerMatchMakeRequest() {

    // TODO: DRY with Server.ts
    const matchmakeRoute = 'matchmake';
    const allowedRoomNameChars = /([a-zA-Z_\-0-9]+)/gi;

    const writeHeaders = (req: uWebSockets.HttpRequest, res: uWebSockets.HttpResponse) => {
      // skip if aborted
      if (res.aborted) { return; }

      const headers = Object.assign(
        {},
        matchMaker.controller.DEFAULT_CORS_HEADERS,
        matchMaker.controller.getCorsHeaders.call(undefined, req)
      );

      for (const header in headers) {
        res.writeHeader(header, headers[header].toString());
      }

      return true;
    }

    const writeError = (res: uWebSockets.HttpResponse, error: { code: number, error: string }) => {
      // skip if aborted
      if (res.aborted) { return; }

      res.writeStatus("406 Not Acceptable");
      res.end(JSON.stringify(error));
    }

    const onAborted = (res: uWebSockets.HttpResponse) => {
      res.aborted = true;
    };

    this.bunServer.options("/matchmake/*", (res, req) => {
      res.onAborted(() => onAborted(res));

      if (writeHeaders(req, res)) {
        res.writeStatus("204 No Content");
        res.end();
      }
    });


    // @ts-ignore
    this.bunServer.post("/matchmake/*", (res, req) => {
      res.onAborted(() => onAborted(res));

      // do not accept matchmaking requests if already shutting down
      if (matchMaker.isGracefullyShuttingDown) {
        return res.close();
      }

      writeHeaders(req, res);
      res.writeHeader('Content-Type', 'application/json');

      const url = req.getUrl();
      const matchedParams = url.match(allowedRoomNameChars);
      const matchmakeIndex = matchedParams.indexOf(matchmakeRoute);

      // read json body
      this.readJson(res, async (clientOptions) => {
        try {
          if (clientOptions === undefined) {
            throw new Error("invalid JSON input");
          }

          const method = matchedParams[matchmakeIndex + 1];
          const roomName = matchedParams[matchmakeIndex + 2] || '';

          const response = await matchMaker.controller.invokeMethod(method, roomName, clientOptions);
          if (!res.aborted) {
            res.writeStatus("200 OK");
            res.end(JSON.stringify(response));
          }

        } catch (e) {
          debugAndPrintError(e);
          writeError(res, {
            code: e.code || ErrorCode.MATCHMAKE_UNHANDLED,
            error: e.message
          });
        }

      });
    });

    // this.app.any("/*", (res, req) => {
    //     res.onAborted(() => onAborted(req));
    //     res.writeStatus("200 OK");
    // });

    this.bunServer.get("/matchmake/*", async (res, req) => {
      res.onAborted(() => onAborted(res));

      writeHeaders(req, res);
      res.writeHeader('Content-Type', 'application/json');

      const url = req.getUrl();
      const matchedParams = url.match(allowedRoomNameChars);
      const roomName = matchedParams.length > 1 ? matchedParams[matchedParams.length - 1] : "";

      try {
        const response = await matchMaker.controller.getAvailableRooms(roomName || '')
        if (!res.aborted) {
          res.writeStatus("200 OK");
          res.end(JSON.stringify(response));
        }

      } catch (e) {
        debugAndPrintError(e);
        writeError(res, {
          code: e.code || ErrorCode.MATCHMAKE_UNHANDLED,
          error: e.message
        });
      }
    });
  }

  /* Helper function for reading a posted JSON body */
  /* Extracted from https://github.com/uNetworking/uWebSockets.js/blob/master/examples/JsonPost.js */
  private readJson(res: uWebSockets.HttpResponse, cb: (json: any) => void) {
    let buffer: any;
    /* Register data cb */
    res.onData((ab, isLast) => {
      let chunk = Buffer.from(ab);
      if (isLast) {
        let json;
        if (buffer) {
          try {
            // @ts-ignore
            json = JSON.parse(Buffer.concat([buffer, chunk]));
          } catch (e) {
            /* res.close calls onAborted */
            // res.close();
            cb(undefined);
            return;
          }
          cb(json);
        } else {
          try {
            // @ts-ignore
            json = JSON.parse(chunk);
          } catch (e) {
            /* res.close calls onAborted */
            // res.close();
            cb(undefined);
            return;
          }
          cb(json);
        }
      } else {
        if (buffer) {
          buffer = Buffer.concat([buffer, chunk]);
        } else {
          buffer = Buffer.concat([chunk]);
        }
      }
    });
  }
}