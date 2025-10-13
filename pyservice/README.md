# Instagrapi Microservice

Run locally:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8081
```

Endpoints:
- POST /login { username, password, verification_code? } -> { success, settings }
- POST /upload_photo { settings_json, photo_path, caption? } -> { success, media_pk }
