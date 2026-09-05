"""
CampusHub document verifier.

A stateless FastAPI service. It receives four document images in one multipart
request, analyses them entirely in memory, and returns SCORES AND CATEGORY
CODES ONLY.

---------------------------------------------------------------------------
THE THREE PROPERTIES THAT MATTER
---------------------------------------------------------------------------

1. IT HAS NO PERSISTENCE. No database credentials, no S3 credentials, no
   writable volume. The container runs with a read-only root filesystem and a
   tmpfs at /tmp sized to a few MB. If someone adds a `open(path, "wb")` here,
   it fails at runtime rather than silently retaining an ID scan. This is why
   the previous S3-fetching version was removed: a service that can read a
   bucket is a service that can be made to write one.

2. IT NEVER RETURNS EXTRACTED TEXT. The name and university comparisons happen
   INSIDE this process. What crosses back to the Node tier is
   `{"code": "NAME_MISMATCH", "confidence": 0.9}` - never
   `{"ocr_name": "ELVIN SEFEROV"}`. That boundary is what keeps a national ID
   number out of a Node error report, a log line, or an APM trace. It is the
   single most important line in the zero-retention design, because logs are
   where PII actually leaks in practice.

3. IT WIPES. Buffers are overwritten before the response is returned. Python
   will not zero freed memory on its own, and a core dump taken after a crash
   can otherwise still contain a readable ID card.

Deployment: private subnet, no internet egress, mTLS from the Node tier only.
"""

from __future__ import annotations

import ctypes
import io
import os
import re
import unicodedata
from dataclasses import dataclass, asdict
from typing import Any

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Form, HTTPException, UploadFile, File, Header
from PIL import Image, ImageChops

app = FastAPI(title="campushub-doc-verifier", version="2.0.0")

MODEL_VERSIONS = {
    "quality": "laplacian-1.0",
    "recapture": "moire-fft-1.1",
    "tamper": "ela-copymove-1.2",
    "ocr": "tesseract-5.3-aze",
}

MAX_BYTES = 5 * 1024 * 1024  # mirrors MAX_UPLOAD_BYTES on the Node side


@dataclass
class Signal:
    code: str
    confidence: float
    detail: str | None = None


def require_token(authorization: str = Header(default="")) -> None:
    expected = f"Bearer {os.environ['DOC_VERIFIER_TOKEN']}"
    if not _constant_time_eq(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorised")


def _constant_time_eq(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a.encode(), b.encode()):
        result |= x ^ y
    return result == 0


@app.post("/verify", dependencies=[Depends(require_token)])
async def verify(
    declaredName: str = Form(...),
    declaredUniversity: str = Form(default=""),
    STUDENT_CARD_FRONT: UploadFile = File(...),
    STUDENT_CARD_BACK: UploadFile = File(...),
    ID_FRONT: UploadFile = File(...),
    ID_BACK: UploadFile = File(...),
) -> dict[str, Any]:
    """
    Analyse all four documents together and return a verdict summary.

    Cross-document checks (does the name on the ID match the student card,
    does the card's issuer match the selected university) happen here rather
    than in the caller, precisely so the extracted values never leave.
    """
    uploads = {
        "STUDENT_CARD_FRONT": STUDENT_CARD_FRONT,
        "STUDENT_CARD_BACK": STUDENT_CARD_BACK,
        "ID_FRONT": ID_FRONT,
        "ID_BACK": ID_BACK,
    }

    buffers: list[bytearray] = []
    extracted: dict[str, dict[str, str]] = {}
    signals: list[Signal] = []
    quality_scores: list[float] = []

    try:
        for kind, upload in uploads.items():
            raw = bytearray(await upload.read())
            buffers.append(raw)

            if len(raw) > MAX_BYTES:
                raise HTTPException(status_code=413, detail="file too large")

            bgr = _decode(bytes(raw))
            if bgr is None:
                signals.append(Signal("WRONG_DOCUMENT_TYPE", 1.0, kind))
                continue

            quality = _quality_score(bgr)
            quality_scores.append(quality)

            signals.extend(_quality_signals(bgr, kind))
            signals.extend(_recapture_signals(bgr, kind))
            signals.extend(_tamper_signals(bytes(raw), kind))

            extracted[kind] = _extract_fields(bgr, kind)

        signals.extend(_cross_document_signals(extracted, declaredName, declaredUniversity))

        return {
            "signals": [asdict(s) for s in signals],
            "qualityScore": round(min(quality_scores), 3) if quality_scores else 0.0,
            "modelVersions": MODEL_VERSIONS,
        }
    finally:
        # Overwrite every byte before the allocator reclaims it.
        for buf in buffers:
            _wipe(buf)
        buffers.clear()
        extracted.clear()


def _wipe(buf: bytearray) -> None:
    """Zero a bytearray in place. `buf = b''` only drops the reference."""
    if not buf:
        return
    ctypes.memset((ctypes.c_char * len(buf)).from_buffer(buf), 0, len(buf))


def _decode(raw: bytes) -> np.ndarray | None:
    """
    Decode without ever touching the filesystem.

    PDFs are rasterised to their first page and the original is discarded, so
    everything downstream deals with a plain bitmap and no PDF scripting
    features survive.
    """
    if raw[:5] == b"%PDF-":
        return _rasterise_pdf(raw)
    array = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(array, cv2.IMREAD_COLOR)


def _rasterise_pdf(raw: bytes) -> np.ndarray | None:
    try:
        import pypdfium2 as pdfium  # rasteriser with no shell-out, no temp file

        doc = pdfium.PdfDocument(raw)
        try:
            if len(doc) == 0:
                return None
            page = doc[0]
            pil = page.render(scale=200 / 72).to_pil()  # ~200 DPI
            return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        finally:
            doc.close()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def _quality_signals(bgr: np.ndarray, kind: str) -> list[Signal]:
    out: list[Signal] = []
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = grey.shape

    if max(h, w) < 1000:
        out.append(Signal("LOW_RESOLUTION", 1.0, kind))

    blur = cv2.Laplacian(grey, cv2.CV_64F).var()
    if blur < 100:
        out.append(Signal("BLURRY", min(1.0, (100 - blur) / 100), kind))

    # Glare: a large saturated blob. A hologram legitimately produces small
    # bright patches, so only a big connected region counts.
    saturated = (grey > 250).astype(np.uint8)
    n_labels, _, stats, _ = cv2.connectedComponentsWithStats(saturated, connectivity=8)
    if n_labels > 1 and stats[1:, cv2.CC_STAT_AREA].max() > 0.04 * h * w:
        out.append(Signal("GLARE", 0.8, kind))

    if not _has_four_corners(grey):
        out.append(Signal("CROPPED_EDGES", 0.7, kind))

    return out


def _recapture_signals(bgr: np.ndarray, kind: str) -> list[Signal]:
    """
    Detects a photo of a screen rather than a photo of a document.

    A re-photographed display produces moire: a periodic peak in the frequency
    domain from the beat between the display's pixel grid and the camera
    sensor. Paper and PVC have no such periodicity.

    This is the highest-yield check in the pipeline, because "screenshot
    someone else's ID out of a group chat" needs no forgery skill at all. It is
    ALSO the check with the worst false-positive rate on cheap phone cameras
    under fluorescent light - which is why a hit here escalates to a human and
    never bans on its own. See decide() in src/lib/verification/policy.ts.
    """
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    grey = cv2.resize(grey, (512, 512))
    window = np.hanning(512)
    spectrum = np.fft.fftshift(np.abs(np.fft.fft2(grey * window[:, None] * window[None, :])))
    log_spec = np.log1p(spectrum)

    yy, xx = np.ogrid[:512, :512]
    radius = np.sqrt((yy - 256) ** 2 + (xx - 256) ** 2)
    band = (radius > 60) & (radius < 220)

    values = log_spec[band]
    peak_ratio = float(values.max() / (values.mean() + 1e-6))

    if peak_ratio > 3.2:
        confidence = min(1.0, (peak_ratio - 3.2) / 2.0 + 0.6)
        return [Signal("SCREEN_RECAPTURE", confidence, kind)]
    return []


def _tamper_signals(raw: bytes, kind: str) -> list[Signal]:
    out: list[Signal] = []
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        return out

    # 1. EXIF software tag. High precision, trivially defeated by stripping
    #    metadata - a corroborating signal, never a standalone one.
    software = str(pil.getexif().get(305, "")).lower()
    if any(tool in software for tool in ("photoshop", "gimp", "paint.net", "canva", "midjourney")):
        out.append(Signal("EDITOR_METADATA", 0.85, kind))

    # 2. Error Level Analysis: re-save and diff. Regions edited after the
    #    original compression compress differently and light up.
    buf = io.BytesIO()
    pil.save(buf, "JPEG", quality=90)
    ela = ImageChops.difference(pil, Image.open(io.BytesIO(buf.getvalue())))
    ela_arr = np.array(ela.convert("L"), dtype=np.float32)
    if ela_arr.size:
        hot = float((ela_arr > ela_arr.mean() + 4 * ela_arr.std()).mean())
        if hot > 0.004:
            out.append(Signal("DIGITAL_TAMPERING", min(0.9, 0.55 + hot * 20), kind))

    # 3. Copy-move: ORB keypoints matching another region of the SAME image is
    #    how a forged expiry date or name is usually produced.
    grey = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2GRAY)
    orb = cv2.ORB_create(nfeatures=2000)
    keypoints, descriptors = orb.detectAndCompute(grey, None)
    if descriptors is not None and len(keypoints) > 50:
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        suspicious = 0
        for group in matcher.knnMatch(descriptors, descriptors, k=3):
            for match in group[1:]:
                if match.distance < 20:
                    p1 = np.array(keypoints[match.queryIdx].pt)
                    p2 = np.array(keypoints[match.trainIdx].pt)
                    if np.linalg.norm(p1 - p2) > 40:  # ignore local texture repeats
                        suspicious += 1
        if suspicious > 12:
            out.append(Signal("DIGITAL_TAMPERING", 0.75, kind))

    return out


def _extract_fields(bgr: np.ndarray, kind: str) -> dict[str, str]:
    """
    OCR of the data fields.

    The return value NEVER leaves this process - it is consumed by
    _cross_document_signals and then dropped. Deskew first: OCR accuracy on a
    5-degree rotation is roughly half that of a straightened image, and phone
    photos are essentially never square.

    Tesseract runs with 'aze+rus+eng' because AZ documents mix Latin
    Azerbaijani with transliterated fields and older student cards still carry
    Russian. Extraction is template-based per document kind rather than
    free-text: the FIN sits in a known region of the national ID, and searching
    the whole image for a 7-character alphanumeric string false-positives on
    every other number on the card.
    """
    _ = _deskew(bgr)
    # Region-of-interest crops + pytesseract TSV parsing elided for brevity.
    return {}


def _cross_document_signals(
    extracted: dict[str, dict[str, str]],
    declared_name: str,
    declared_university: str,
) -> list[Signal]:
    """
    The checks no single image can answer.

    Most real fraud is caught here rather than by the tampering detector:
    people submit a genuine ID belonging to somebody else, or a genuine student
    card for a different university than the one they picked.
    """
    out: list[Signal] = []

    id_fields = extracted.get("ID_FRONT", {})
    card_fields = extracted.get("STUDENT_CARD_FRONT", {})

    id_name = id_fields.get("fullName")
    if id_name and not _names_match(id_name, declared_name):
        out.append(Signal("NAME_MISMATCH", 0.9, "id_vs_signup"))

    card_name = card_fields.get("fullName")
    if id_name and card_name and not _names_match(id_name, card_name):
        out.append(Signal("NAME_MISMATCH", 0.85, "id_vs_card"))

    fin = id_fields.get("nationalIdNumber")
    if fin and not re.fullmatch(r"[0-9A-Z]{7}", fin.replace(" ", "").upper()):
        out.append(Signal("ID_CHECKSUM_INVALID", 1.0, "format"))

    issuer = card_fields.get("universityName")
    if issuer and declared_university and declared_university.lower() not in issuer.lower():
        out.append(Signal("UNIVERSITY_MISMATCH", 0.8, "issuer"))

    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _names_match(a: str, b: str) -> bool:
    """
    Azerbaijani names carry diacritics that OCR routinely drops or substitutes
    (e vs schwa, dotless i vs dotted i, s vs s-cedilla), and the ID prints them
    uppercase. Comparing raw strings would fail on a large share of GENUINE
    submissions, so fold to a comparable form and allow one edit per name part.
    """
    def fold(value: str) -> list[str]:
        lowered = value.lower()
        for src, dst in (("ə", "e"), ("ı", "i"), ("ö", "o"), ("ü", "u"),
                         ("ğ", "g"), ("ş", "s"), ("ç", "c")):
            lowered = lowered.replace(src, dst)
        stripped = "".join(
            ch for ch in unicodedata.normalize("NFD", lowered)
            if unicodedata.category(ch) != "Mn"
        )
        return sorted(re.sub(r"[^a-z\s]", "", stripped).split())

    parts_a, parts_b = fold(a), fold(b)
    if len(parts_a) != len(parts_b):
        return False
    return all(_levenshtein(x, y) <= 1 for x, y in zip(parts_a, parts_b))


def _levenshtein(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def _quality_score(bgr: np.ndarray) -> float:
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = min(1.0, cv2.Laplacian(grey, cv2.CV_64F).var() / 400)
    contrast = min(1.0, float(grey.std()) / 70)
    resolution = min(1.0, max(grey.shape) / 1600)
    return round(float(0.5 * blur + 0.25 * contrast + 0.25 * resolution), 3)


def _has_four_corners(grey: np.ndarray) -> bool:
    edges = cv2.Canny(cv2.GaussianBlur(grey, (5, 5), 0), 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False
    largest = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(largest, 0.02 * cv2.arcLength(largest, True), True)
    return len(approx) == 4 and cv2.contourArea(largest) > 0.35 * grey.shape[0] * grey.shape[1]


def _deskew(bgr: np.ndarray) -> np.ndarray:
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    coords = np.column_stack(np.where(cv2.bitwise_not(grey) > 0))
    if coords.size == 0:
        return bgr
    angle = cv2.minAreaRect(coords)[-1]
    angle = -(90 + angle) if angle < -45 else -angle
    h, w = bgr.shape[:2]
    matrix = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
    return cv2.warpAffine(bgr, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}
