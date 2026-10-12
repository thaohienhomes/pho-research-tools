Static files here are served before the rewrite to api/index.mjs.
icon.png / favicon.png: the listing icon directories load from https://mcp.pho.chat/icon.png.
Every other path is served by api/index.mjs.
.well-known/glama.json: Glama directory ownership claim.
.well-known/openai-apps-challenge: OpenAI plugin directory domain verification token (public by design).
