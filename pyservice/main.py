import os
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException
from instagrapi import Client
from pydantic import BaseModel

app = FastAPI()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET")


class LoginRequest(BaseModel):
    username: str
    password: str
    verification_code: Optional[str] = None


class UploadPhotoRequest(BaseModel):
    settings_json: dict
    caption: Optional[str] = None
    photo_path: str


class UploadVideoRequest(BaseModel):
    settings_json: dict
    caption: Optional[str] = None
    video_path: str


@app.post("/login")
def login(req: LoginRequest):
    cl = Client()
    try:
        cl.login(req.username, req.password, verification_code=req.verification_code)
        settings = cl.get_settings()
        return {"success": True, "settings": settings}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/upload_photo")
def upload_photo(req: UploadPhotoRequest):
    cl = Client()
    try:
        cl.set_settings(req.settings_json)
        cl.get_timeline_feed()  # warm up session
        
        photo_path = ensure_media_path(req.photo_path)
        if not os.path.exists(photo_path):
            raise HTTPException(status_code=404, detail=f"Photo file not found: {req.photo_path}")
            
        media = cl.photo_upload(photo_path, req.caption or "")
        return {"success": True, "media_pk": media.pk, "media_id": media.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/upload_video")
def upload_video(req: UploadVideoRequest):
    cl = Client()
    try:
        cl.set_settings(req.settings_json)
        cl.get_timeline_feed()  # warm up session
        
        video_path = ensure_media_path(req.video_path)
        if not os.path.exists(video_path):
            raise HTTPException(status_code=404, detail=f"Video file not found: {req.video_path}")
            
        media = cl.video_upload(video_path, req.caption or "")
        return {"success": True, "media_pk": media.pk, "media_id": media.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def ensure_media_path(original_path: str) -> str:
    target_path = original_path if os.path.isabs(original_path) else os.path.abspath(original_path)
    if os.path.exists(target_path):
        return target_path

    if not (SUPABASE_URL and SUPABASE_KEY and SUPABASE_BUCKET):
        return target_path

    rel_key = os.path.relpath(target_path, os.getcwd()).replace("\\", "/")
    if rel_key.startswith(".."):
        rel_key = original_path.lstrip("./")

    try:
        response = requests.get(
            f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{rel_key}",
            headers={
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Apikey": SUPABASE_KEY,
            },
            timeout=30,
        )
        if response.status_code >= 400:
            raise HTTPException(status_code=404, detail=f"Media not found in storage: {original_path}")

        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        with open(target_path, "wb") as fh:
            fh.write(response.content)
        return target_path
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch media from storage: {exc}") from exc

