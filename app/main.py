import os
from datetime import timedelta
from sqlalchemy import select, delete, func
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Depends, HTTPException, Request, Form


from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.db import get_db, engine
from app.models import Base, Company, License, Device, ScriptVersion, gen_key

Base.metadata.create_all(bind=engine)

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()
BASE_URL = os.getenv("BASE_URL", "").strip().rstrip("/")

app = FastAPI(title="AutoSuite License Server")
templates = Jinja2Templates(directory="app/templates")

def require_admin(request: Request):
    token = request.headers.get("x-admin-token") or request.query_params.get("token")
    if not ADMIN_TOKEN or token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")

def now_utc():
    return datetime.now(timezone.utc)

def pick_allowed_version(db: Session, company: Company) -> str:
    if company.pinned_version:
        return company.pinned_version

    ch = (company.channel or "stable").lower()
    row = db.execute(
        select(ScriptVersion).where(ScriptVersion.channel == ch).order_by(ScriptVersion.id.desc())
    ).scalars().first()

    if not row:
        row = db.execute(select(ScriptVersion).order_by(ScriptVersion.id.desc())).scalars().first()

    return row.version if row else "3.2.0"

@app.get("/", response_class=PlainTextResponse)
def root():
    return "OK"

@app.get("/admin", response_class=HTMLResponse)
def admin_page(request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    companies = db.execute(select(Company).order_by(Company.id.desc())).scalars().all()
   # Licenses + device counts
rows = db.execute(
    select(
        License,
        func.count(Device.id).label("device_count")
    )
    .outerjoin(Device, Device.license_id == License.id)
    .group_by(License.id)
    .order_by(License.id.desc())
).all()

licenses = []
for lic, device_count in rows:
    # attach count so the template can use l.device_count
    lic.device_count = int(device_count or 0)
    licenses.append(lic)

@app.post("/admin/company/create")
def admin_create_company(
    request: Request,
    name: str = Form(...),
    allowed_domain: str | None = Form(None),
    db: Session = Depends(get_db),
):
    require_admin(request)
    c = Company(name=name.strip(), allowed_domain=(allowed_domain.strip() if allowed_domain else None))
    db.add(c)
    db.commit()
    return {"ok": True, "company_id": c.id}

@app.post("/admin/version/create")
def admin_create_version(
    request: Request,
    version: str = Form(...),
    channel: str = Form("stable"),
    notes: str | None = Form(None),
    db: Session = Depends(get_db),
):
    require_admin(request)
    v = ScriptVersion(version=version.strip(), channel=channel.strip().lower(), notes=notes)
    db.add(v)
    db.commit()
    return {"ok": True}

@app.post("/admin/license/create")
def admin_create_license(
    request: Request,
    company_id: int = Form(...),
    days: int = Form(30),
    max_devices: int = Form(2),
    db: Session = Depends(get_db),
):
    require_admin(request)
    comp = db.get(Company, company_id)
    if not comp:
        raise HTTPException(404, "company not found")
    key = gen_key("AS")
    exp = now_utc() + timedelta(days=days)
    lic = License(company_id=company_id, license_key=key, active=True, expires_at=exp, max_devices=max_devices)
    db.add(lic)
    db.commit()
    return {"ok": True, "license_key": key, "expires_at": exp.isoformat()}


@app.post("/admin/license/extend")
def admin_extend_license(
    request: Request,
    license_key: str = Form(...),
    days: int = Form(30),
    db: Session = Depends(get_db),
):
    require_admin(request)
    lic = db.execute(select(License).where(License.license_key == license_key.strip())).scalars().first()
    if not lic:
        raise HTTPException(404, "license not found")
    base = lic.expires_at if lic.expires_at > now_utc() else now_utc()
    lic.expires_at = base + timedelta(days=days)
    lic.active = True
    db.commit()
    return {"ok": True, "expires_at": lic.expires_at.isoformat()}

@app.post("/admin/license/block")
def admin_block_license(
    request: Request,
    license_key: str = Form(...),
    db: Session = Depends(get_db),
):
    require_admin(request)
    lic = db.execute(select(License).where(License.license_key == license_key.strip())).scalars().first()
    if not lic:
        raise HTTPException(404, "license not found")
    lic.active = False
    db.commit()
    return {"ok": True}

@app.post("/admin/license/adjust")
def admin_adjust_license(
    request: Request,
    license_key: str = Form(...),
    days_delta: int = Form(...),
    db: Session = Depends(get_db),
):
    require_admin(request)

    lic = db.execute(
        select(License).where(License.license_key == license_key.strip())
    ).scalars().first()

    if not lic:
        raise HTTPException(status_code=404, detail="license not found")

    lic.expires_at = lic.expires_at + timedelta(days=days_delta)

    # Optional safety: prevent setting expiry earlier than "now"
    # If you want to allow past expiry dates, remove these 2 lines:
    if lic.expires_at < now_utc():
        lic.expires_at = now_utc()

    db.commit()
    return {"ok": True, "expires_at": lic.expires_at.isoformat()}


@app.post("/admin/license/delete")
def admin_delete_license(
    request: Request,
    license_key: str = Form(...),
    db: Session = Depends(get_db),
):
    require_admin(request)

    lic = db.execute(
        select(License).where(License.license_key == license_key.strip())
    ).scalars().first()

    if not lic:
        raise HTTPException(status_code=404, detail="license not found")

@app.post("/admin/license/reset_devices")
def admin_reset_devices(
    request: Request,
    license_key: str = Form(...),
    db: Session = Depends(get_db),
):
    require_admin(request)

    lic = db.execute(
        select(License).where(License.license_key == license_key.strip())
    ).scalars().first()

    if not lic:
        raise HTTPException(status_code=404, detail="license not found")

    db.execute(delete(Device).where(Device.license_id == lic.id))
    db.commit()
    return {"ok": True}

    # Hard delete: remove devices first, then license
    db.execute(delete(Device).where(Device.license_id == lic.id))
    db.execute(delete(License).where(License.id == lic.id))
    db.commit()

    return {"ok": True}

@app.post("/admin/company/update_control")
def admin_update_control(
    request: Request,
    company_id: int = Form(...),
    channel: str | None = Form(None),
    pinned_version: str | None = Form(None),
    force_update: str | None = Form(None),  # "true"/"false"/None
    db: Session = Depends(get_db),
):
    require_admin(request)
    comp = db.get(Company, company_id)
    if not comp:
        raise HTTPException(404, "company not found")

    if channel is not None and channel.strip():
        comp.channel = channel.strip().lower()

    comp.pinned_version = pinned_version.strip() if pinned_version and pinned_version.strip() else None

    if force_update is not None and force_update.strip():
        comp.force_update = (force_update.strip().lower() == "true")

    db.commit()
    return {"ok": True}

@app.get("/api/check")
def api_check(license_key: str, device_id: str, host: str | None = None, db: Session = Depends(get_db)):
    lic = db.execute(select(License).where(License.license_key == license_key.strip())).scalars().first()
    if not lic:
        return {"active": False, "reason": "invalid_license"}

    comp = db.get(Company, lic.company_id)
    if not comp:
        return {"active": False, "reason": "company_missing"}

    if not lic.active:
        return {"active": False, "reason": "blocked"}

    if lic.expires_at <= now_utc():
        return {"active": False, "reason": "expired", "expires_at": lic.expires_at.isoformat()}

    if comp.allowed_domain and host and comp.allowed_domain.lower() not in host.lower():
        return {"active": False, "reason": "domain_not_allowed"}

    existing = db.execute(select(Device).where(Device.license_id == lic.id, Device.device_id == device_id)).scalars().first()
    if not existing:
        count = db.execute(select(func.count(Device.id)).where(Device.license_id == lic.id)).scalar_one()
        if count >= lic.max_devices:
            return {"active": False, "reason": "device_limit_reached"}
        db.add(Device(license_id=lic.id, device_id=device_id))
        db.commit()
    else:
        existing.last_seen_at = now_utc()
        db.commit()

    allowed_version = pick_allowed_version(db, comp)
    latest = db.execute(select(ScriptVersion).order_by(ScriptVersion.id.desc())).scalars().first()
    latest_version = latest.version if latest else allowed_version

    script_url = f"{BASE_URL}/scripts/{allowed_version}/core.js" if BASE_URL else f"/scripts/{allowed_version}/core.js"

    return {
        "active": True,
        "company": comp.name,
        "allowed_version": allowed_version,
        "latest_version": latest_version,
        "force_update": bool(comp.force_update),
        "script_url": script_url,
        "expires_at": lic.expires_at.isoformat(),
        "check_interval_seconds": 6 * 3600,
        "offline_grace_seconds": 24 * 3600
    }

@app.get("/scripts/{version}/core.js", response_class=PlainTextResponse)
def serve_core(version: str):
    path = f"core_scripts/{version}.js"
    if not os.path.exists(path):
        raise HTTPException(404, "script version not found")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()
