/** Non-interactive adapter for the user's existing portable pdf2zh runtime. */
export const DCS_MODEL = 'deepseek-v4-flash';
export const DCS_BASE_URL = 'https://dcsapi.dcs.cloud/api/aigress/unified/v1';

export const TRANSLATION_CHILD_SCRIPT = String.raw`param([string]$RequestPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
$request = $null
function Read-Exactly($stream, [int]$count) {
    $bytes = New-Object byte[] $count
    $offset = 0
    while ($offset -lt $count) {
        $read = $stream.Read($bytes, $offset, $count - $offset)
        if ($read -eq 0) { throw 'SECRET_FRAME_INCOMPLETE' }
        $offset += $read
    }
    return ,$bytes
}
try {
    $request = [IO.File]::ReadAllText($RequestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $request.provider.id) { throw 'PROVIDER_NOT_CONFIGURED' }
    $stdin = [Console]::OpenStandardInput()
    $header = Read-Exactly $stdin 4
    $length = ([int]$header[0] -shl 24) -bor ([int]$header[1] -shl 16) -bor ([int]$header[2] -shl 8) -bor [int]$header[3]
    if ($length -lt 1 -or $length -gt 65536) { throw 'SECRET_FRAME_INVALID' }
    $frame = [Text.Encoding]::UTF8.GetString((Read-Exactly $stdin $length)) | ConvertFrom-Json
    if ($frame.jobId -ne $request.jobId -or $frame.providerId -ne $request.provider.id -or -not $frame.apiKey) { throw 'SECRET_FRAME_INVALID' }
    $env:PDF2ZH_OPENAI_API_KEY = $frame.apiKey
    $frame = $null
    $env:PYTHONPATH = $env:ORANGE_LIBS_ROOT
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:PYTHONUTF8 = '1'
    $env:USERPROFILE = $env:ORANGE_CACHE_ROOT
    $env:HF_ENDPOINT = 'https://hf-mirror.com'
    $program = @'
import contextlib, json, logging, os, shutil, sys, time, threading, hashlib
from pathlib import Path

sys.path.insert(0, os.environ["ORANGE_LIBS_ROOT"])
logging.disable(logging.CRITICAL)
_progress_lock = threading.RLock()
# ponytail: one translation worker per job; aggregate if the engine later uses several.
_api_counts = {"started": 0, "completed": 0, "failed": 0, "active": 0, "characters": 0}
_last_progress_write = 0

def progress(stage, event=None, characters=0):
    global _last_progress_write
    location = os.environ.get("ORANGE_PROGRESS_PATH")
    if not location:
        return
    with _progress_lock:
        if event == "start":
            _api_counts["started"] += 1
            _api_counts["active"] += 1
        elif event in ("completed", "failed"):
            _api_counts[event] += 1
            _api_counts["active"] -= 1
        _api_counts["characters"] += characters
        now = time.time()
        if event is None and stage in ("API_RECEIVING", "API_PROCESSING") and now - _last_progress_write < 1:
            return
        _last_progress_write = now
        try:
            path = Path(location)
            temporary = path.with_suffix("." + str(os.getpid()) + ".tmp")
            temporary.write_text(json.dumps({"jobId": os.environ["ORANGE_PROGRESS_JOB_ID"],
                "stage": stage, "updatedMs": int(now * 1000), "api": dict(_api_counts)}), encoding="utf-8")
            temporary.replace(path)
        except OSError:
            pass

def install_dcs_adapter():
    from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator
    protocol = os.environ.get("ORANGE_API_PROTOCOL", "responses")
    base_url = os.environ.get("ORANGE_API_BASE_URL", "${DCS_BASE_URL}")
    if protocol == "chat":
        # The SDK handles transient retries; avoid the engine's extra 100-attempt wrapper.
        original_translate = getattr(OpenAITranslator.do_translate, "__wrapped__", OpenAITranslator.do_translate)
        original_llm_translate = getattr(OpenAITranslator.do_llm_translate, "__wrapped__", OpenAITranslator.do_llm_translate)
        def tracked(original):
            def call(self, text, rate_limit_params=None):
                if text is None:
                    return None
                progress("API_REQUEST", event="start")
                try:
                    translated = original(self, text, rate_limit_params)
                    if not isinstance(translated, str) or not translated.strip():
                        raise RuntimeError("PROVIDER_RESPONSE_EMPTY")
                    progress("API_FINISHED", event="completed", characters=len(translated))
                    return translated
                except Exception:
                    progress("API_FAILED", event="failed")
                    raise
            return call
        OpenAITranslator.name = "ot-chat-" + hashlib.sha256(base_url.encode()).hexdigest()[:8]
        OpenAITranslator.do_translate = tracked(original_translate)
        OpenAITranslator.do_llm_translate = tracked(original_llm_translate)
        return
    if protocol != "responses":
        raise ValueError("INVALID_PROTOCOL")

    def dcs_response(self, input_text):
        chunks, completed = [], None
        progress("API_REQUEST", event="start")
        try:
            with self.client.responses.create(model=self.model, input=input_text, stream=True) as events:
                for item in events:
                    if item.type == "response.output_text.delta":
                        chunks.append(item.delta)
                        progress("API_RECEIVING", characters=len(item.delta))
                    elif item.type == "response.completed":
                        completed = item.response
                    elif item.type in ("error", "response.failed", "response.incomplete"):
                        raise RuntimeError("PROVIDER_RESPONSE_FAILED")
                    elif "reasoning" in item.type:
                        progress("API_PROCESSING")
            if completed is None or completed.status != "completed":
                raise RuntimeError("PROVIDER_RESPONSE_INCOMPLETE")
            text = self._remove_cot_content(completed.output_text or "".join(chunks)).strip()
            if not text:
                raise RuntimeError("PROVIDER_RESPONSE_EMPTY")
            usage = getattr(completed, "usage", None)
            if usage:
                self.token_count.inc(usage.total_tokens or 0)
                self.prompt_token_count.inc(usage.input_tokens or 0)
                self.completion_token_count.inc(usage.output_tokens or 0)
            progress("API_FINISHED", event="completed")
            return text
        except Exception:
            progress("API_FAILED", event="failed")
            raise

    def dcs_translate(self, text, rate_limit_params=None):
        return dcs_response(self, self.prompt(text))

    def dcs_llm_translate(self, text, rate_limit_params=None):
        return None if text is None else dcs_response(self, text)

    # Keep the engine's prompts, layout, rate limiter and cache. Patch only this child.
    OpenAITranslator.name = "dcs-responses" if base_url == "${DCS_BASE_URL}" else "ot-resp-" + hashlib.sha256(base_url.encode()).hexdigest()[:8]
    OpenAITranslator.do_translate = dcs_translate
    OpenAITranslator.do_llm_translate = dcs_llm_translate

def main():
    request_path, result_path = map(Path, sys.argv[1:3])
    request = json.loads(request_path.read_text(encoding="utf-8-sig"))
    result = {"schemaVersion": 1, "jobId": request["jobId"]}
    failure = "TRANSLATION_FAILED"
    try:
        source = Path(request["inputPdf"]).resolve()
        output = Path(request["outputDir"]).resolve()
        if not source.is_file() or not output.is_dir() or result_path.resolve().parent != output:
            raise ValueError("INVALID_REQUEST")
        os.environ["ORANGE_PROGRESS_PATH"] = str(output / "progress.json")
        os.environ["ORANGE_PROGRESS_JOB_ID"] = request["jobId"]
        progress("PREPARING_ASSETS")
        cache = Path(os.environ["ORANGE_CACHE_ROOT"]) / ".cache" / "babeldoc"
        models = Path(os.environ["ORANGE_MODELS_ROOT"])
        cache.mkdir(parents=True, exist_ok=True)
        # Reuse bundled assets locally; never overwrite an existing cache file.
        if models.is_dir():
            for directory, _, files in os.walk(models):
                relative = Path(directory).relative_to(models)
                destination = cache / relative
                destination.mkdir(parents=True, exist_ok=True)
                for name in files:
                    if not (destination / name).exists():
                        shutil.copy2(Path(directory) / name, destination / name)
        pool_max_workers = int(os.environ.get("ORANGE_POOL_MAX_WORKERS", "16"))
        if not 1 <= pool_max_workers <= 64:
            raise ValueError("INVALID_WORKER_COUNT")
        sys.argv = ["pdf2zh_next", str(source), "--openai", "--openai-model",
                    request["provider"].get("model") or "${DCS_MODEL}",
                    "--openai-base-url", os.environ.get("ORANGE_API_BASE_URL", "${DCS_BASE_URL}"), "--openai-timeout", "120",
                    "--lang-in", "en", "--lang-out", "zh", "--output", str(output),
                    "--no-auto-extract-glossary", "--qps", "4", "--pool-max-workers", str(pool_max_workers)]
        failure = "RUNTIME_INCOMPATIBLE"
        install_dcs_adapter()
        import pdf2zh_next.high_level as high_level
        original_stream = high_level.do_translate_async_stream
        async def tracked_stream(*args, **kwargs):
            async for event in original_stream(*args, **kwargs):
                kind = event.get("type")
                if kind in ("progress_start", "progress_update", "progress_end", "finish"):
                    data = {"jobId": request["jobId"], "type": kind, "updatedMs": int(time.time() * 1000)}
                    if kind == "finish":
                        data.update(stage="FINISHED", overallProgress=100)
                    else:
                        stages = {"Parse PDF and Create Intermediate Representation": "PARSE_PDF", "Parse Page Layout": "LAYOUT",
                            "Translate Paragraphs": "TRANSLATE_TEXT", "Typesetting": "TYPESETTING", "Save PDF": "SAVE_PDF"}
                        data["stage"] = stages.get(event.get("stage"), "PROCESSING")
                        for field, target in [("overall_progress", "overallProgress"), ("stage_progress", "stageProgress"),
                            ("stage_current", "stageCurrent"), ("stage_total", "stageTotal"), ("part_index", "partIndex"), ("total_parts", "totalParts")]:
                            number = event.get(field)
                            if isinstance(number, (int, float)) and not isinstance(number, bool) and 0 <= number <= 1_000_000_000:
                                if target.endswith("Progress") and number > 100:
                                    continue
                                data[target] = number
                    path = output / "engine-progress.json"
                    temporary = path.with_suffix(".tmp")
                    try:
                        temporary.write_text(json.dumps(data, allow_nan=False), encoding="utf-8")
                        temporary.replace(path)
                    except OSError:
                        pass
                yield event
        high_level.do_translate_async_stream = tracked_stream
        from pdf2zh_next.main import cli
        failure = "TRANSLATION_FAILED"
        progress("RUNNING_TRANSLATOR")
        # Engine logs stay out of the host's diagnostics and cannot echo a key.
        with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            try:
                cli()
            except SystemExit as exit_result:
                if exit_result.code not in (None, 0):
                    raise RuntimeError("TRANSLATION_FAILED")
        worker_progress = json.loads((output / "progress.json").read_text(encoding="utf-8"))
        if worker_progress.get("api", {}).get("failed", 0):
            failure = "PROVIDER_UNREACHABLE"
            raise RuntimeError("PARTIAL_TRANSLATION_FAILED")
        progress("VALIDATING_OUTPUT")
        files = [p.resolve() for p in output.rglob("*.pdf")]
        dual = [p for p in files if p.name.lower().endswith(".dual.pdf")]
        mono = [p for p in files if p.name.lower().endswith(".mono.pdf")]
        if len(dual) != 1 or len(mono) != 1:
            raise RuntimeError("RESULT_MISSING")
        for pdf in (dual[0], mono[0]):
            if not pdf.is_relative_to(output) or pdf == source:
                raise ValueError("OUTPUT_OUTSIDE_JOB_DIR")
            with pdf.open("rb") as stream:
                if stream.read(5) != b"%PDF-":
                    raise ValueError("PDF_VALIDATION_FAILED")
        result.update(status="completed", outputs={"dualPdf": str(dual[0]), "monoPdf": str(mono[0])})
    except Exception:
        progress("FAILED")
        result.update(status="failed", error={"code": failure, "messageRedacted": "The local translator did not produce verified PDFs."})
    finally:
        os.environ.pop("PDF2ZH_OPENAI_API_KEY", None)
    temporary = result_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    temporary.replace(result_path)

# Reinstall only the API adapter when Windows reloads this module in a worker.
if __name__ == "__mp_main__":
    install_dcs_adapter()
elif __name__ == "__main__":
    main()
'@
    $pythonScript = Join-Path $request.outputDir 'translate.py'
    [IO.File]::WriteAllText($pythonScript, $program, (New-Object Text.UTF8Encoding($false)))
    & $env:ORANGE_PYTHON_EXE $pythonScript $RequestPath $ResultPath | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ResultPath)) { throw 'RUNTIME_INCOMPATIBLE' }
    exit 0
}
catch {
    if ($request) {
        $result = @{schemaVersion=1; jobId=$request.jobId; status='failed'; error=@{code='RUNTIME_INCOMPATIBLE'; messageRedacted='The local runtime adapter could not complete the job.'}}
        [IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
        exit 0
    }
    exit 1
}
finally { $env:PDF2ZH_OPENAI_API_KEY = $null }
`;
