from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from instagrapi import Client

app = FastAPI()


class LoginRequest(BaseModel):
    username: str
    password: str
    verification_code: Optional[str] = None


class UploadPhotoRequest(BaseModel):
    settings_json: dict
    caption: Optional[str] = None
    photo_path: str


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
        pk = cl.photo_upload(req.photo_path, req.caption or "").pk
        return {"success": True, "media_pk": pk}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


