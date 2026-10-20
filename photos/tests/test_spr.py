"""SPR session logic against a fake portal. Synthetic IC numbers only; nothing touches the live site."""

import asyncio

import pytest

import settings as settings_mod
import spr
from automation import TransientError
from spr import SprService, build_voter, classify, extract_fields

IC = "010101010101"  # synthetic
OTHER_IC = "020202020202"

RESULT_TEXT = "\n".join([
    "MAKLUMAT PERIBADI PEMILIH",
    f"No. Kad Pengenalan\t:\t{IC}",
    "Nama\t:\tPEMILIH UJIAN SATU",
    "Tarikh Lahir\t:\t01-01-2001",
    "Jantina\t:\tLELAKI",
    "DAFTAR PEMILIH YANG TELAH DISAHKAN",
    "Lokaliti\t:\t173/23/01/001 - KG CONTOH",
    "Daerah Mengundi\t:\t173/23/01 - CONTOH",
    "DUN\t:\tN.23 - PETAGAS",
    "Parlimen\t:\tP.173 - PUTATAN",
    "Negeri\t:\tSABAH",
])


def snap(text="", messages=(), has_form=False, status=None, title="MySPR Semak", url="https://x/semakan/daftarPemilihPapar"):
    return {"text": text, "messages": list(messages), "has_form": has_form, "status": status, "title": title, "url": url}


# ---------------------------------------------------------------- parsing


def test_extract_fields_handles_three_row_shapes():
    tabbed = extract_fields(["Nama\t:\tA B", "Parlimen\tP.001 - X"])
    inline = extract_fields(["Nama : A B", "Parlimen: P.001 - X"])
    stacked = extract_fields(["Nama", ":", "A B", "Parlimen", "P.001 - X"])
    for f in (tabbed, inline, stacked):
        assert f["name"] == "A B" and f["parliament"] == "P.001 - X"


@pytest.mark.parametrize("label", ["Nama Penuh", "NAMA PEMILIH", "Nama Penuh Pemilih", "Nama (Seperti Dalam MyKad)"])
def test_name_label_variants(label):
    for lines in ([f"{label}\t:\tA B"], [f"{label} : A B"], [label, ":", "A B"]):
        assert extract_fields(lines)["name"] == "A B"


def test_long_or_numeric_nama_text_is_not_a_label():
    assert "name" not in extract_fields(["Nama pusat mengundi yang sangat panjang sekali\tX"])
    assert "name" not in extract_fields(["Nama 2\tX"])
    assert "name" not in extract_fields(["Nama Bapa\t:\tX", "Nama Pusat Mengundi\t:\tY"])


def test_diagnostics_show_unknown_labels_but_never_values():
    text = "\n".join([f"No. Kad Pengenalan\t:\t{IC}", "Nama Bapa\t:\tPEMILIH RAHSIA", "Catatan : nota 123",
                      "Parlimen\t:\tP.173 - PUTATAN", "BARIS TANPA LABEL"])
    out = classify(snap(text), IC)
    d = out["diagnostics"]
    assert d["unknown_labels"] == ["nama bapa", "catatan"]
    assert d["line_shapes"][0] == "K:ic" and d["line_shapes"][3] == "K:parliament"
    blob = repr(d)
    for secret in ("PEMILIH RAHSIA", "nota", IC, "PUTATAN", "BARIS"):
        assert secret not in blob


def test_label_without_value_is_not_filled_from_next_label():
    f = extract_fields(["Nama", "Parlimen", "P.001 - X"])
    assert "name" not in f
    assert f["parliament"] == "P.001 - X"


def test_build_voter_parses_codes():
    v, reason = build_voter(extract_fields(RESULT_TEXT.split("\n")), IC)
    assert reason == ""
    assert v["full_name"] == "PEMILIH UJIAN SATU"
    assert v["parlimen"] == {"code": "173", "name": "PUTATAN"}
    assert v["dun"] == {"code": "173/23", "name": "PETAGAS"}
    assert v["daerah_mengundi"] == {"code": "173/23/01", "name": "CONTOH"}
    assert v["lokaliti"] == {"code": "173/23/01/001", "name": "KG CONTOH"}
    assert v["state"] == "SABAH"


def test_federal_territory_without_state_seat():
    f = {"name": "A", "parliament": "P.117 SEGAMBUT", "state": "WILAYAH PERSEKUTUAN KUALA LUMPUR", "dun": "-"}
    v, _ = build_voter(f, IC)
    assert v["dun"] == {"code": "", "name": ""}
    assert v["parlimen"] == {"code": "117", "name": "SEGAMBUT"}


def test_missing_fields_are_not_inferred():
    v, reason = build_voter({"name": "A", "parliament": "P.173 PUTATAN"}, IC)
    assert v is None and reason == "missing:state"
    v, _ = build_voter({"name": "A", "parliament": "P.173 PUTATAN", "state": "SABAH"}, IC)
    assert v["daerah_mengundi"] == {"code": "", "name": ""}
    assert v["lokaliti"] == {"code": "", "name": ""}


def test_result_for_a_different_ic_is_rejected():
    out = classify(snap(RESULT_TEXT), OTHER_IC)
    assert out["status"] == "unexpected_layout" and out["reason"] == "ic_mismatch"


# ---------------------------------------------------------------- classification


def test_classify_outcomes():
    assert classify(snap(RESULT_TEXT), IC)["status"] == "found"
    assert classify(snap("form", ["Captcha tidak sah"], has_form=True), IC)["status"] == "captcha_wrong"
    assert classify(snap("form", ["Harap maaf. Tiada rekod dalam daftar pemilih"], has_form=True), IC)["status"] == "not_registered"
    assert classify(snap("form", [], has_form=True), IC)["status"] == "captcha_wrong"
    pm = classify(snap("form", [f"Sila cuba lagi {IC}"], has_form=True), IC)
    assert pm["status"] == "portal_message" and IC not in pm["message"]
    assert classify(snap("", status=403), IC) == {"status": "blocked", "reason": "access_denied"}
    assert classify(snap("Just a moment...", title="Just a moment..."), IC)["status"] == "blocked"


def test_partial_or_changed_page_is_unexpected_and_diagnostics_hold_no_values():
    partial = "\n".join(["Nama\t:\tPEMILIH UJIAN SATU", "Parlimen\t:\t(sedang dimuatkan)"])
    out = classify(snap(partial), IC)
    assert out["status"] == "unexpected_layout"
    blob = repr(out["diagnostics"])
    assert "PEMILIH UJIAN SATU" not in blob and IC not in blob
    out = classify(snap("Laman baharu tanpa label"), IC)
    assert out["status"] == "unexpected_layout" and out["reason"] == "no_result"


# ---------------------------------------------------------------- session state machine


class FakePortal:
    def __init__(self, outcomes, *, open_errors=(), open_status=200, form=True, captcha_rotates=False):
        self.outcomes = list(outcomes)
        self.open_errors = list(open_errors)
        self.open_status = open_status
        self.form = form
        self.captcha_rotates = captcha_rotates
        self.src_n = 0
        self.submits = 0
        self.opens = 0
        self.ic = ""
        self.answer = ""
        self.closed = False
        self.last = None

    async def open(self):
        self.opens += 1
        if self.open_errors:
            raise self.open_errors.pop(0)
        return self.open_status

    async def fill_ic(self, ic):
        self.ic = ic

    async def captcha(self):
        self.src_n += 1
        return f"/captcha/spr?{self.src_n}", b"\x89PNG fake"

    async def captcha_src(self):
        if self.captcha_rotates:
            return "/captcha/spr?rotated"
        return f"/captcha/spr?{self.src_n}"

    async def refresh_captcha(self, old):
        pass

    async def fill_answer(self, a):
        self.answer = a

    async def submit(self):
        self.submits += 1
        await asyncio.sleep(0.01)
        self.last = self.outcomes.pop(0)
        if isinstance(self.last, BaseException):
            raise self.last

    async def has_result(self):
        return False

    async def snapshot(self):
        if self.last is None:
            return snap("Semak Daftar Pemilih CAPTCHA", has_form=self.form, status=self.open_status)
        return self.last

    async def close(self):
        self.closed = True


def make_service(portal, pages=1):
    s = settings_mod.Settings(
        browser=settings_mod.BrowserSettings(max_concurrent_pages=pages),
        execution=settings_mod.ExecutionSettings(minimum_action_interval_ms=0, maximum_action_interval_ms=0,
                                                 retry_backoff_ms=1),
    )
    released = []

    async def open_portal():
        return portal, "ctx"

    async def release(ctx):
        released.append(ctx)

    svc = SprService(s, open_portal, release=release)
    return svc, released


JOB = "11111111-2222-3333-4444-555555555555"
JOB2 = "11111111-2222-3333-4444-666666666666"


def test_happy_path_submits_once_and_frees_the_browser():
    portal = FakePortal([snap(RESULT_TEXT)])
    svc, released = make_service(portal)

    async def go():
        first = await svc.start(JOB, IC)
        assert first["status"] == "awaiting_captcha" and first["captcha"].startswith("data:image/png;base64,")
        assert portal.ic == IC  # the voter's own input, not a fixed test value
        res = await svc.answer(JOB, "1234")
        assert res["status"] == "found" and res["voter"]["parlimen"]["code"] == "173"
        assert res["ic"] == IC  # handed back once so the API can bind the record to its job
        again = await svc.answer(JOB, "1234")  # repeated request: same outcome, no second submission
        assert again["status"] == "found" and "ic" not in again
        return released

    assert run(go()) == ["ctx"]
    assert portal.submits == 1
    assert svc.sessions[JOB].ic == ""


def test_invalid_ic_never_opens_the_portal():
    portal = FakePortal([])
    svc, _ = make_service(portal)
    assert run(svc.start(JOB, "12345")) == {"status": "invalid_input"}
    assert run(svc.start(JOB, "99012312557A")) == {"status": "invalid_input"}
    assert portal.opens == 0


def test_duplicate_start_reuses_the_session():
    portal = FakePortal([])
    svc, _ = make_service(portal, pages=2)

    async def go():
        a, b = await asyncio.gather(svc.start(JOB, IC), svc.start(JOB, IC))
        c = await svc.start(JOB, IC)
        return a, b, c

    a, b, c = run(go())
    assert a["status"] == b["status"] == c["status"] == "awaiting_captcha"
    assert portal.opens == 1
    assert svc.stats.dedup_hits == 2


def test_concurrent_answers_submit_once():
    portal = FakePortal([snap(RESULT_TEXT), snap(RESULT_TEXT)])
    svc, _ = make_service(portal)

    async def go():
        await svc.start(JOB, IC)
        return await asyncio.gather(svc.answer(JOB, "1234"), svc.answer(JOB, "1234"))

    results = run(go())
    assert portal.submits == 1
    assert sorted(r["status"] for r in results) == ["found", "in_progress"]


def test_wrong_captcha_gets_a_new_image_and_attempts_are_capped(monkeypatch):
    monkeypatch.setattr(spr, "MAX_CAPTCHA_ATTEMPTS", 2)
    wrong = snap("form", ["Captcha tidak sah"], has_form=True)
    portal = FakePortal([wrong, wrong])
    svc, released = make_service(portal)

    async def go():
        await svc.start(JOB, IC)
        r1 = await svc.answer(JOB, "1111")
        assert r1["status"] == "captcha_wrong" and r1["attempts_left"] == 1
        r2 = await svc.answer(JOB, "2222")
        assert r2["status"] == "too_many_attempts"

    run(go())
    assert portal.submits == 2
    assert released == ["ctx"]


def test_rotated_captcha_is_not_submitted():
    portal = FakePortal([snap(RESULT_TEXT)], captcha_rotates=True)
    svc, _ = make_service(portal)

    async def go():
        await svc.start(JOB, IC)
        return await svc.answer(JOB, "1234")

    assert run(go())["status"] == "captcha_expired"
    assert portal.submits == 0


def test_submit_timeout_is_not_retried():
    portal = FakePortal([asyncio.TimeoutError()])
    svc, released = make_service(portal)

    async def go():
        await svc.start(JOB, IC)
        r = await svc.answer(JOB, "1234")
        again = await svc.answer(JOB, "1234")
        return r, again

    r, again = run(go())
    assert r["status"] == "unavailable" and again is r
    assert portal.submits == 1
    assert released == ["ctx"]


def test_access_denied_on_open_stops():
    portal = FakePortal([], open_status=403)
    svc, released = make_service(portal)
    assert run(svc.start(JOB, IC)) == {"status": "blocked", "reason": "access_denied"}
    assert released == ["ctx"]
    assert svc.slots._value == 1  # slot given back


def test_missing_form_is_reported_as_layout_change():
    portal = FakePortal([], form=False)
    svc, _ = make_service(portal)
    assert run(svc.start(JOB, IC))["status"] == "unexpected_layout"
    assert svc.slots._value == 1


def test_transient_open_errors_retry_then_give_up():
    portal = FakePortal([], open_errors=[TransientError("503"), TransientError("503"), TransientError("503")])
    svc, _ = make_service(portal)
    assert run(svc.start(JOB, IC)) == {"status": "unavailable"}
    assert portal.opens == 3  # 1 + maximum_retries (2)
    assert svc.stats.retries["open"] == 2

    portal = FakePortal([], open_errors=[TransientError("503")])
    svc, _ = make_service(portal)
    assert run(svc.start(JOB, IC))["status"] == "awaiting_captcha"
    assert portal.opens == 2


def test_page_slots_are_bounded(monkeypatch):
    monkeypatch.setattr(spr, "SLOT_WAIT", 0.05)
    svc, _ = make_service(FakePortal([]), pages=1)

    async def go():
        assert (await svc.start(JOB, IC))["status"] == "awaiting_captcha"
        assert (await svc.start(JOB2, OTHER_IC))["status"] == "busy"
        await svc.cancel(JOB)
        assert (await svc.start(JOB2, OTHER_IC))["status"] == "awaiting_captcha"

    run(go())


def test_expired_sessions_are_swept(monkeypatch):
    now = [0.0]
    portal = FakePortal([])
    svc, released = make_service(portal)
    svc._clock = lambda: now[0]

    async def go():
        await svc.start(JOB, IC)
        now[0] = spr.SESSION_TTL + 1
        await svc.sweep()
        assert (await svc.answer(JOB, "1234"))["status"] == "expired"
        now[0] += 120
        await svc.sweep()
        assert JOB not in svc.sessions

    run(go())
    assert released == ["ctx"]
    assert portal.submits == 0


def test_internal_api_requires_token():
    aiohttp = pytest.importorskip("aiohttp")
    from aiohttp.test_utils import TestClient, TestServer

    svc, _ = make_service(FakePortal([snap(RESULT_TEXT)]))

    async def go():
        async with TestClient(TestServer(spr.make_app(svc))) as client:
            r = await client.post("/sessions", json={"job_id": JOB, "ic": IC})
            assert r.status == 401
            h = {"X-Internal-Token": "test-token"}
            r = await client.post("/sessions", json={"job_id": "nope", "ic": IC}, headers=h)
            assert r.status == 400
            r = await client.post("/sessions", json={"job_id": JOB, "ic": IC}, headers=h)
            assert (await r.json())["status"] == "awaiting_captcha"
            r = await client.post(f"/sessions/{JOB}/captcha", json={"answer": "12a4"}, headers=h)
            assert (await r.json())["status"] == "invalid_answer"
            r = await client.post(f"/sessions/{JOB}/captcha", json={"answer": "1234"}, headers=h)
            assert (await r.json())["status"] == "found"
            r = await client.get("/stats", headers=h)
            body = await r.json()
            assert body["requests"]["submit"] == 1 and body["open_sessions"] == 0

    run(go())


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- IC formats on the result page


@pytest.mark.parametrize("value", [
    IC, "010101-01-0101", f"{IC} (A1234567)", f"A1234567 / {IC}", "010101-01-****", "010101******",
    f"{IC[:6]}-{IC[6:8]}-XXXX", f"No. KP: {IC}",
])
def test_ic_value_formats_that_match(value):
    assert spr.ic_matches(value, IC)


@pytest.mark.parametrize("value", [
    OTHER_IC, "020202-02-****", "******020202", "01010*******", "0101010101", "", "A1234567",
    "010101-01-0102",
])
def test_ic_values_that_must_not_match(value):
    assert not spr.ic_matches(value, IC)


def test_result_with_old_ic_alongside_is_found():
    text = RESULT_TEXT.replace(f"No. Kad Pengenalan\t:\t{IC}", f"No. Kad Pengenalan\t:\t{IC} (A1234567)")
    assert classify(snap(text), IC)["status"] == "found"


def test_ic_mismatch_diagnostics_show_shape_only():
    out = classify(snap(RESULT_TEXT.replace(IC, OTHER_IC)), IC)
    assert out["reason"] == "ic_mismatch"
    assert out["diagnostics"]["ic_value_shape"] == "dddddddddddd"
    assert OTHER_IC not in repr(out)


@pytest.mark.parametrize("url,kind,keep", [
    ("https://mysprsemak.spr.gov.my/semakan/daftarPemilih", "document", True),
    ("https://mysprsemak.spr.gov.my/captcha/spr?abc", "image", True),
    ("https://mysprsemak.spr.gov.my/spr/img/logo.png", "image", False),
    ("https://mysprsemak.spr.gov.my/spr/css/app.css", "stylesheet", True),
    ("https://cdn.jsdelivr.net/npm/sweetalert2@9.17.2/dist/sweetalert2.all.min.js", "script", True),
    ("http://ajax.googleapis.com/ajax/libs/jquery/1.9.1/jquery.js", "script", False),
    ("https://fonts.gstatic.com/x.woff2", "font", False),
    ("https://www.google-analytics.com/collect", "xhr", False),
])
def test_asset_filter(url, kind, keep):
    assert spr.keep_request(url, kind) is keep


# ---------------------------------------------------------------- many voters at once


def test_twenty_voters_share_ten_slots(monkeypatch):
    """20 voters arrive together with 10 browser slots: the first 10 get a CAPTCHA at once, the
    rest wait in line and get theirs as soon as earlier voters finish. Nobody is turned away."""
    monkeypatch.setattr(spr, "SLOT_WAIT", 5)
    s = settings_mod.Settings(
        browser=settings_mod.BrowserSettings(max_concurrent_pages=10),
        execution=settings_mod.ExecutionSettings(minimum_action_interval_ms=0, maximum_action_interval_ms=0),
    )
    portals = []

    async def open_portal():
        p = FakePortal([snap(RESULT_TEXT.replace(IC, ic)) for ic in [current_ic.pop(0)]])
        portals.append(p)
        return p, "ctx"

    async def release(ctx):
        pass

    ics = [f"0101010{i:05d}" for i in range(20)]
    current_ic = list(ics)
    svc = SprService(s, open_portal, release=release)
    jobs = [f"11111111-2222-3333-4444-{i:012d}" for i in range(20)]

    async def voter(job, ic):
        r = await svc.start(job, ic)
        assert r["status"] == "awaiting_captcha", r
        await asyncio.sleep(0.02)  # the voter reads the CAPTCHA
        return await svc.answer(job, "1234")

    async def go():
        return await asyncio.gather(*(voter(j, ic) for j, ic in zip(jobs, ics)))

    results = run(go())
    assert [r["status"] for r in results] == ["found"] * 20
    assert sorted(r["ic"] for r in results) == sorted(ics)  # each voter got their own record
    assert svc.slots._value == 10 and svc.waiting == 0
    assert sum(p.submits for p in portals) == 20


def test_found_result_keeps_every_row_verbatim():
    text = RESULT_TEXT + "\nStatus Pemilih\t:\tPEMILIH BIASA\nNota : Sila bawa MyKad\nSila masukkan No. Kad Pengenalan (cth: 98xxxxxxxxxx) tanpa jarak"
    out = classify(snap(text), IC)
    assert out["status"] == "found"
    raw = {f["label"]: f["value"] for f in out["raw_fields"]}
    assert raw["Nama"] == "PEMILIH UJIAN SATU"
    assert raw["Status Pemilih"] == "PEMILIH BIASA"  # not a field we parse, still kept
    assert raw["Nota"] == "Sila bawa MyKad"
    assert not any(k.startswith("Sila masukkan") for k in raw)  # page instructions are not fields


def test_raw_fields_only_travel_with_found_results():
    out = classify(snap(RESULT_TEXT.replace(IC, OTHER_IC)), IC)
    assert "raw_fields" not in out
