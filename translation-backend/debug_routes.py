from app.main import app

print("FastAPI app routes:")
for route in app.routes:
    if hasattr(route, 'path'):
        methods = getattr(route, 'methods', ['WEBSOCKET' if 'websocket' in str(type(route)).lower() else 'UNKNOWN'])
        print(f"  {route.path} - {methods} - {type(route).__name__}")
    else:
        print(f"  {route} - {type(route).__name__}")

print("\nWebSocket routes specifically:")
for route in app.routes:
    if 'websocket' in str(type(route)).lower():
        print(f"  WebSocket: {route.path}")
