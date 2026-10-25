// One public port in front of the clearing service and the fleet, so a single tunnel (or a
// single reverse proxy rule) exposes the whole backend:
//   /agents/*, /guest(s)/*, /control/* -> fleet         (agent cards, A2A, guest sessions)
//   everything else, incl. WebSockets -> clearing service (REST, /v1/live, /hsp gateway)
import { createServer, request } from "node:http";
import { connect } from "node:net";

const FLEET_PATHS = /^\/(agents|guests|guest|control)(\/|$)/;

export function startEdge({ port, clearingPort, fleetPort, log = console.log }) {
  const target = (url) => (FLEET_PATHS.test(url ?? "/") ? fleetPort : clearingPort);
  const server = createServer((req, res) => {
    const up = request({ host: "127.0.0.1", port: target(req.url), path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream unavailable: ${err.message}` }));
    });
    req.pipe(up);
  });
  // WebSocket (and any other upgrade): splice the raw sockets together
  server.on("upgrade", (req, socket, head) => {
    const up = connect(target(req.url), "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      up.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
  });
  server.listen(port, "0.0.0.0", () => log(`edge on :${port} -> clearing :${clearingPort}, fleet :${fleetPort}`));
  return server;
}

if (process.argv[1]?.endsWith("edge.mjs")) {
  startEdge({ port: Number(process.env.EDGE_PORT ?? 8790), clearingPort: Number(process.env.PORT ?? 8787), fleetPort: Number(process.env.FLEET_PORT ?? 8788) });
}
