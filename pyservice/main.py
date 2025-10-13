from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from instagrapi import Client
import os

app = FastAPI()


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
        
        if not os.path.exists(req.photo_path):
            raise HTTPException(status_code=404, detail=f"Photo file not found: {req.photo_path}")
            
        media = cl.photo_upload(req.photo_path, req.caption or "")
        return {"success": True, "media_pk": media.pk, "media_id": media.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/upload_video")
def upload_video(req: UploadVideoRequest):
    cl = Client()
    try:
        cl.set_settings(req.settings_json)
        cl.get_timeline_feed()  # warm up session
        
        if not os.path.exists(req.video_path):
            raise HTTPException(status_code=404, detail=f"Video file not found: {req.video_path}")
            
        media = cl.video_upload(req.video_path, req.caption or "")
        return {"success": True, "media_pk": media.pk, "media_id": media.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


