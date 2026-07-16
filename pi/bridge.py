#!/usr/bin/env python3
"""
CellScope Pi bridge — Raspberry Pi Zero 2 W.

Serves the app over http AND relays WebSocket commands to the Arduino
over USB serial. Both from one process, on purpose: a browser will not
let an https page open a ws:// socket to your LAN, so the only way the
WebSocket route works is if the page itself is served from this Pi.

    pip3 install websockets pyserial
    python3 bridge.py --serial /dev/ttyUSB0 --root ..

Then browse to http://<pi-address>:8000 and choose "WebSocket -> Pi"
with host ws://<pi-address>:8765.

Hardware choice: Pi Zero 2 W (~$15, wifi built in, runs off a phone power
bank for a day). A Pi 4 is overkill here and eats batteries. If you have
no Pi at all, use the ESP32 build of the firmware and Bluetooth instead —
fewer parts, less to break, and no power budget to worry about.
"""
import argparse, asyncio, functools, http.server, socketserver, threading

try:
    import serial
except ImportError:
    serial = None
import websockets


class Stage:
    def __init__(self, port, baud=115200):
        self.lock = asyncio.Lock()
        self.ser = None
        if port and serial:
            self.ser = serial.Serial(port, baud, timeout=8)
            # Arduino boards reset when the port opens; wait for the bootloader
            import time; time.sleep(2.0)
            self.ser.reset_input_buffer()

    async def send(self, cmd: str) -> str:
        async with self.lock:                       # one command in flight at a time
            if not self.ser:
                await asyncio.sleep(0.12)           # simulator
                return "OK"
            loop = asyncio.get_running_loop()
            def io():
                self.ser.write((cmd.strip() + "\n").encode())
                return self.ser.readline().decode(errors="replace").strip() or "ERR timeout"
            return await loop.run_in_executor(None, io)


async def handler(ws, stage):
    async for msg in ws:
        for line in str(msg).splitlines():
            if line.strip():
                await ws.send(await stage.send(line))


def serve_static(root, port):
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("", port), h)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"app served at http://0.0.0.0:{port}  (open this on the phone)")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default=None, help="e.g. /dev/ttyUSB0; omit to simulate")
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--root", default="..", help="folder containing index.html")
    a = ap.parse_args()

    if a.serial and not serial:
        raise SystemExit("pyserial missing: pip3 install pyserial")
    stage = Stage(a.serial)
    print("stage:", a.serial or "SIMULATED (no --serial given)")
    serve_static(a.root, a.http_port)
    async with websockets.serve(lambda ws: handler(ws, stage), "0.0.0.0", a.ws_port):
        print(f"stage bridge on ws://0.0.0.0:{a.ws_port}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
