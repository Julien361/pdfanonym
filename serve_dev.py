#!/usr/bin/env python3
"""Serveur de développement : sert dist/ (relu à chaque requête) avec le même CSP que la prod."""
import http.server, socketserver, os
from functools import partial
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}
    def translate_path(self, path):
        self.directory = ROOT
        return super().translate_path(path)
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache"); self.send_header("Content-Security-Policy", CSP); super().end_headers()
    def log_message(self, *a): pass
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("127.0.0.1", 8811), partial(H, directory=ROOT)).serve_forever()
