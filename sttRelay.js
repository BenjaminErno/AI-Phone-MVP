import http from "http";
import crypto from "crypto";
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

const { WebSocket } = globalThis;

dotenv.config();

const RELAY_PORT = parseInt(process.env.RELAY_PORT || "10001", 10);
const RELAY_HOST = process.env.RELAY_HOST || "0.0.0.0";
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || null;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || null;
const DEEPGRAM_WS_URL = (process.env.DEEPGRAM_WS_URL || "wss://api.deepgram.com/v1/listen").replace(/\/$/, "");
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "fi";
const DEEPGRAM_ENCODING = process.env.DEEPGRAM_ENCODING || "mulaw";
const DEEPGRAM_SAMPLE_RATE = parseInt(process.env.DEEPGRAM_SAMPLE_RATE || "8000", 10);
const DEEPGRAM_CHANNELS = parseInt(process.env.DEEPGRAM_CHANNELS || "1", 10);

const serverBase = normalizeBase(
  process.env.SERVER_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 10000}`
);

const TRANSCRIPTION_TARGET =
  normalizeUrl(process.env.TRANSCRIPTION_WEBHOOK_URL) ||
  `${serverBase}/transcription`;

const sessionsByCallId = new Map();
const sessionsById = new Map();

const app = express();
app.use(express.json());

app.get("/healthz", (req, res) => res.send("ok"));

app.delete("/sessions/:callId", (req, res) => {
  if (RELAY_AUTH_TOKEN && req.headers["x-relay-token"] !== RELAY_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, message: "unauthorized" });
  }
  const callId = req.params.callId;
  const session = sessionsByCallId.get(callId);
  if (!session) {
    return res.status(404).json({ ok: false, message: "session not found" });
  }
  closeSession(session, "cleanup requested");
  return res.json({ ok: true });
});

const httpServer = http.createServer(app);
httpServer.on("upgrade", (req, socket, head) => {
  const { pathname, searchParams } = parseRequestUrl(req);
  if (pathname !== "/media") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const authToken =
    searchParams.get("token") || req.headers["x-relay-token"] || null;
  if (RELAY_AUTH_TOKEN && authToken !== RELAY_AUTH_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const callIdFromQuery =
    searchParams.get("callId") ||
    searchParams.get("call_id") ||
    searchParams.get("stream_key") ||
    null;

  if (!req.headers["sec-websocket-key"]) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const acceptKey = createWebSocketAccept(req.headers["sec-websocket-key"]);
  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];
  socket.write(responseHeaders.concat("\r\n").join("\r\n"));

  const session = createSession(req, socket, callIdFromQuery);
  sessionsById.set(session.id, session);
  if (session.callId) {
    attachSessionToCall(session, session.callId);
  }
  if (head && head.length) {
    handleSocketData(session, head);
  }
});

httpServer.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(`🔁 STT relay listening on ${RELAY_HOST}:${RELAY_PORT}`);
  if (!DEEPGRAM_API_KEY) {
    console.warn("⚠️ DEEPGRAM_API_KEY is not set. Transcriptions will be disabled.");
  }
});

function normalizeBase(url) {
  if (!url) return url;
  return url.replace(/\/$/, "");
}

function normalizeUrl(url) {
  if (!url) return url;
  return url.replace(/\/$/, "");
}

function parseRequestUrl(req) {
  const host = req.headers.host || "localhost";
  const fullUrl = new URL(req.url, `http://${host}`);
  return { pathname: fullUrl.pathname, searchParams: fullUrl.searchParams };
}

function createWebSocketAccept(secKey) {
  return crypto
    .createHash("sha1")
    .update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "binary")
    .digest("base64");
}

function createSession(req, socket, initialCallId) {
  const id = crypto.randomUUID();
  const session = {
    id,
    socket,
    buffer: Buffer.alloc(0),
    closed: false,
    callId: initialCallId || null,
    streamId: null,
    deepgram: null,
    deepgramReady: false,
    pendingAudio: [],
    telnyxClientState: req.headers["sec-websocket-protocol"] || null
  };

  socket.on("data", chunk => handleSocketData(session, chunk));
  socket.on("close", () => closeSession(session, "telnyx closed"));
  socket.on("error", err => {
    console.error(`⚠️ Telnyx socket error (session=${id}):`, err);
    closeSession(session, "socket error");
  });

  return session;
}

function attachSessionToCall(session, callId) {
  if (!callId) return;
  const existing = sessionsByCallId.get(callId);
  if (existing && existing !== session) {
    console.warn(
      `♻️ Replacing existing relay session for call ${callId} (${existing.id} → ${session.id})`
    );
    closeSession(existing, "superseded");
  }
  session.callId = callId;
  sessionsByCallId.set(callId, session);
}

function detachSession(session) {
  if (session.callId) {
    const existing = sessionsByCallId.get(session.callId);
    if (existing === session) {
      sessionsByCallId.delete(session.callId);
    }
  }
  sessionsById.delete(session.id);
}

function closeSession(session, reason = "closed") {
  if (session.closed) return;
  session.closed = true;
  detachSession(session);
  if (session.deepgram) {
    try {
      if (session.deepgram.readyState === WebSocket.OPEN) {
        session.deepgram.send(
          JSON.stringify({ type: "stop_request", reason: reason })
        );
      }
      session.deepgram.close();
    } catch (err) {
      console.error(`⚠️ Failed to close Deepgram socket (${session.id}):`, err);
    }
    session.deepgram = null;
  }
  try {
    session.socket.end();
  } catch (err) {
    console.error(`⚠️ Failed to end Telnyx socket (${session.id}):`, err);
  }
  console.log(
    `🚪 Closed relay session ${session.id} for call ${session.callId || "unknown"}: ${reason}`
  );
}

function handleSocketData(session, chunk) {
  session.buffer = Buffer.concat([session.buffer, chunk]);
  while (session.buffer.length >= 2) {
    const firstByte = session.buffer[0];
    const secondByte = session.buffer[1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (session.buffer.length < 4) return;
      payloadLength = session.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (session.buffer.length < 10) return;
      const big = session.buffer.readBigUInt64BE(2);
      payloadLength = Number(big);
      offset = 10;
    }

    if (!masked) {
      console.error("❌ Received unmasked frame from Telnyx, closing session");
      closeSession(session, "protocol error");
      return;
    }

    if (session.buffer.length < offset + 4 + payloadLength) {
      return;
    }

    const maskingKey = session.buffer.slice(offset, offset + 4);
    offset += 4;
    const payload = session.buffer.slice(offset, offset + payloadLength);
    session.buffer = session.buffer.slice(offset + payloadLength);

    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= maskingKey[i % 4];
    }

    if (!fin) {
      console.warn("⚠️ Fragmented WebSocket frame received; ignoring");
      continue;
    }

    handleFrame(session, opcode, payload);
  }
}

function handleFrame(session, opcode, payload) {
  switch (opcode) {
    case 0x1:
      handleTelnyxMessage(session, payload.toString("utf8"));
      break;
    case 0x2:
      // Telnyx is expected to send JSON text frames.
      console.warn("⚠️ Binary frame received from Telnyx; ignoring");
      break;
    case 0x8:
      closeSession(session, "received close");
      break;
    case 0x9:
      sendFrame(session.socket, 0xA, payload);
      break;
    case 0xA:
      break;
    default:
      console.warn(`⚠️ Unsupported WebSocket opcode ${opcode}`);
  }
}

function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  let body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, body]));
}

function handleTelnyxMessage(session, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    console.error("⚠️ Failed to parse Telnyx message", err, raw);
    return;
  }

  const eventType = message.event || message.event_type || message.type;

  if (eventType === "start") {
    session.streamId = message.stream_id || session.streamId;
    const newCallId =
      message.call_id ||
      message.stream_key ||
      message.call_control_id ||
      message.start?.call_id ||
      message.start?.call_control_id ||
      session.callId;
    attachSessionToCall(session, newCallId);
    ensureDeepgram(session);
    return;
  }

  if (eventType === "media") {
    const payload = message.media?.payload || message.payload;
    if (!payload) return;
    const audioBuffer = Buffer.from(payload, "base64");
    forwardAudio(session, audioBuffer);
    return;
  }

  if (eventType === "stop" || eventType === "finished" || eventType === "close") {
    closeSession(session, `telnyx event: ${eventType}`);
    return;
  }

  if (eventType === "keepalive") {
    return;
  }

  console.log(`ℹ️ Telnyx event ${eventType} received`);
}

function ensureDeepgram(session) {
  if (session.deepgram || !DEEPGRAM_API_KEY || session.closed) return;
  const headers = { Authorization: `Token ${DEEPGRAM_API_KEY}` };
  const ws = new WebSocket(DEEPGRAM_WS_URL, { headers });
  session.deepgram = ws;
  session.deepgramReady = false;
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    session.deepgramReady = true;
    const config = {
      type: "start_request",
      config: {
        language: DEEPGRAM_LANGUAGE,
        encoding: DEEPGRAM_ENCODING,
        sample_rate: DEEPGRAM_SAMPLE_RATE,
        channels: DEEPGRAM_CHANNELS,
        interim_results: false,
        smart_format: true,
        punctuate: true,
        endpointing: 300
      }
    };
    ws.send(JSON.stringify(config));
    flushPendingAudio(session);
    console.log(
      `🧬 Deepgram connection ready for session ${session.id} (call ${session.callId || "unknown"})`
    );
  };

  ws.onmessage = event => {
    handleDeepgramMessage(session, event.data);
  };

  ws.onerror = event => {
    console.error(`⚠️ Deepgram socket error (${session.id}):`, event?.message || event);
  };

  ws.onclose = event => {
    session.deepgramReady = false;
    if (!session.closed) {
      console.warn(
        `⚠️ Deepgram connection closed unexpectedly (${session.id}): ${event.reason || event.code}`
      );
    }
  };
}

function flushPendingAudio(session) {
  if (!session.deepgram || !session.deepgramReady) return;
  if (!session.pendingAudio.length) return;
  for (const chunk of session.pendingAudio) {
    try {
      session.deepgram.send(chunk);
    } catch (err) {
      console.error(`⚠️ Failed to flush audio chunk (${session.id}):`, err);
    }
  }
  session.pendingAudio.length = 0;
}

function forwardAudio(session, buffer) {
  if (!buffer || !buffer.length) return;
  if (!DEEPGRAM_API_KEY) return;

  if (!session.deepgram) {
    ensureDeepgram(session);
  }

  if (session.deepgram && session.deepgramReady) {
    try {
      session.deepgram.send(buffer);
    } catch (err) {
      console.error(`⚠️ Failed to forward audio to Deepgram (${session.id}):`, err);
    }
  } else {
    session.pendingAudio.push(buffer);
  }
}

function handleDeepgramMessage(session, data) {
  let message;
  try {
    if (typeof data === "string") {
      message = JSON.parse(data);
    } else {
      message = JSON.parse(Buffer.from(data).toString("utf8"));
    }
  } catch (err) {
    console.error(`⚠️ Failed to parse Deepgram message (${session.id}):`, err);
    return;
  }

  const type = message.type || message.message_type;
  if (!type) return;

  if (type.toLowerCase() === "results" && message.channel) {
    const alternatives = message.channel.alternatives || [];
    if (!alternatives.length) return;
    const alt = alternatives[0];
    const transcript = (alt.transcript || "").trim();
    const isFinal = Boolean(message.is_final ?? message.speech_final ?? message.final);
    if (isFinal && transcript && session.callId) {
      postTranscript(session, transcript, {
        confidence: alt.confidence,
        words: alt.words,
        isFinal
      });
    }
    return;
  }

  if (type.toLowerCase() === "error") {
    console.error(`❌ Deepgram error (${session.id}):`, message);
  }
}

async function postTranscript(session, transcript, metadata = {}) {
  if (!TRANSCRIPTION_TARGET) return;

  const payload = {
    callId: session.callId,
    streamId: session.streamId,
    transcript,
    metadata
  };

  const headers = { "Content-Type": "application/json" };
  if (RELAY_AUTH_TOKEN) headers["X-Relay-Token"] = RELAY_AUTH_TOKEN;

  try {
    const response = await fetch(TRANSCRIPTION_TARGET, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await safeText(response);
      console.error(
        `⚠️ Failed to POST transcript for call ${session.callId}: ${response.status} ${text}`
      );
    }
  } catch (err) {
    console.error(`⚠️ Failed to deliver transcript (${session.id}):`, err);
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (err) {
    return "<no-body>";
  }
}

process.on("SIGINT", () => {
  console.log("👋 Relay shutting down");
  for (const session of Array.from(sessionsById.values())) {
    closeSession(session, "shutdown");
  }
  httpServer.close(() => process.exit(0));
});
