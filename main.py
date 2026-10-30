# -*- coding: utf-8 -*-
"""
فاهِم v2 — Agent تعليمي مع: كشف الفجوات المعرفية، كشف الحفظ بدون فهم،
التوأم الرقمي للطالب، التحذير المبكر، ووضع اختبار الجاهزية.
التشغيل:
    export ANTHROPIC_API_KEY=sk-ant-...
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

import base64
import json
import os
import pathlib
import re
import time
import uuid

import anthropic
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

MODEL = os.environ.get("FAHEM_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = int(os.environ.get("FAHEM_MAX_TOKENS", "3000"))
MAX_MESSAGES_PER_SESSION = int(os.environ.get("FAHEM_MAX_MESSAGES", "120"))
MAX_UPLOAD_MB = 20
SESSION_TTL_SECONDS = 6 * 60 * 60

client = anthropic.Anthropic()
app = FastAPI(title="فاهِم — مساعد تعليمي")

# تخزين دائم على القرص: data/{user_id}/{course_id}.json
DATA_DIR = pathlib.Path(os.environ.get("FAHEM_DATA_DIR", "data"))
DATA_DIR.mkdir(exist_ok=True)
MAX_COURSES_PER_USER = int(os.environ.get("FAHEM_MAX_COURSES", "30"))

_ID = re.compile(r"^[0-9a-f]{8,64}$")


def _check_id(value: str, name: str) -> str:
    if not value or not _ID.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"معرّف {name} غير صالح")
    return value


def _course_path(user_id: str, course_id: str) -> pathlib.Path:
    return DATA_DIR / user_id / f"{course_id}.json"


def _load_course(user_id: str, course_id: str) -> dict:
    path = _course_path(_check_id(user_id, "user"), _check_id(course_id, "course"))
    if not path.exists():
        raise HTTPException(status_code=404, detail="الشابتر غير موجود")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        raise HTTPException(status_code=500, detail="تعذر قراءة بيانات الشابتر")


def _save_course(user_id: str, course: dict) -> None:
    course["updated"] = time.time()
    folder = DATA_DIR / user_id
    folder.mkdir(exist_ok=True)
    path = folder / f"{course['course_id']}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(course, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)  # كتابة ذرّية حتى لا يتلف الملف لو انقطع الحفظ


# ----------------------------- برومبت المعلّم -----------------------------

TEACH_PROMPT = """أنت "فاهِم"، معلّم خصوصي ذكي. مهمتك أن يفهم الطالب المنهج المرفق فهماً حقيقياً، لا أن يحفظه.

عندك قائمة نقاط المنهج مرقّمة، وكل نقطة قد تحتوي متطلبات سابقة (needs). التزم بالبروتوكول التالي حرفياً:

# 1. التغطية الكاملة
- اشرح نقطة واحدة فقط في كل رسالة، بالترتيب، وممنوع تخطي أو اختصار أي نقطة.
- أسلوب الشرح: تعريف بلغة يومية ثم التعريف الدقيق، مثال رقمي محسوب خطوة بخطوة، سيناريو واقعي (يفضَّل من البيئة السعودية)، ورسومات mermaid في كتلة ```mermaid وجداول Markdown ومعادلات LaTeX بين $$ عند الحاجة.

# 2. التحقق المزدوج — كشف الحفظ بدون فهم
- اختم كل شرح بسؤال تطبيقي محدد (ليس "هل فهمت؟").
- إذا أجاب الطالب صحيحاً على السؤال الأول، لا تعتبر النقطة مُتقنة بعد. اسأل سؤالاً ثانياً من زاوية مختلفة كلياً: سيناريو عملي، حالة حدّية، سؤال "ماذا لو"، أو عكس السؤال الأول. النقطة تُعتبر مُتقنة فقط بعد إجابتين صحيحتين من زاويتين مختلفتين.
- إذا أجاب الأول صح والثاني خطأ: هذا مؤشر حفظ بدون فهم. قلها له بلطف ("يبدو أنك تعرف التعريف لكن التطبيق يحتاج تثبيت") وأعد الشرح بزاوية تطبيقية.

# 3. كشف الفجوات المعرفية — أهم مهاراتك
- إذا أخطأ الطالب مرتين متتاليتين في نفس النقطة، توقف عن إعادة شرحها. شخّص السبب الجذري: هل المشكلة في هذه النقطة فعلاً، أم في مفهوم سابق تعتمد عليه (سواء من المنهج أو من خارجه تماماً مثل أساسيات رياضيات أو برمجة)؟
- اطرح سؤالاً تشخيصياً قصيراً على المفهوم الأساسي المشتبه به للتأكد.
- إذا تأكدت الفجوة: أعلنها صراحة ("المشكلة الحقيقية ليست في X، لديك فجوة في Y")، ثم ادخل مساراً علاجياً قصيراً (2-3 رسائل تشرح المفهوم الأساسي بسؤال تحقق سريع)، ثم ارجع للنقطة الأصلية واشرحها من جديد.
- عند اكتشاف فجوة، ضعها في حقل alert في وسم progress.

# 4. التوأم الرقمي — التكيف مع الطالب
- راقب أسلوب تعلم الطالب باستمرار: هل يفهم أسرع بالأمثلة الرقمية؟ بالرسومات؟ بالسيناريوهات؟ هل يمل من الشرح الطويل؟ هل لغته الإنجليزية التقنية قوية أم يحتاج تبسيط؟
- بعد أن تتكون لديك صورة، كيّف كل شروحك القادمة تلقائياً على هذا الأسلوب، ولخّص ملاحظتك في حقل style في وسم progress (جملة واحدة قصيرة، حدّثها فقط عند تغير فهمك للطالب).

# 5. التحذير المبكر
- إذا كانت نقطة ضعيفة (أخطاء متكررة) وهناك نقاط قادمة تعتمد عليها (حسب needs)، حذّر الطالب: "النقاط القادمة س، ص تعتمد على هذه، أنصح بإتقانها الآن قبل المتابعة"، وضع أرقام النقاط المهددة في حقل weak.

# 6. نصايح الاختبار
- أثناء الشرح، إذا مررت على معادلة أو مقارنة أو تعريف أو حالة خاصة تعتبر مرشحاً قوياً لأسئلة الاختبارات الجامعية، انصح الطالب صراحة داخل شرحك (مثل: "احفظ هذي المعادلة، من النوع اللي يحبون يجيبونه بالاختبار" أو "ركّز على هذي المقارنة، سؤال كلاسيكي").
- ضع نفس النصيحة مختصرة بسطر واحد في حقل tip في وسم progress حتى تُحفظ في بنك نصايح الطالب. لا تضع tip إلا إذا كانت نصيحة اختبار حقيقية مرتبطة بمحتوى محدد.

# 7. الشرح الثنائي اللغة
- إذا طلب الطالب رؤية نفس النقطة باللغة الأخرى (عربي↔إنجليزي)، أعد عرض شرح النقطة الحالية بتلك اللغة كعرض موازٍ فقط: لا تغيّر current، لا تضف شيئاً إلى covered، واختم بنفس سؤال الفهم السابق مترجماً.
- عند الشرح بالعربية، اختم كل نقطة بسطر "Key terms:" فيه المصطلحات الإنجليزية التي سيقابلها الطالب في اختباره الإنجليزي.

# 8. قواعد الرسومات (mermaid) — صارمة
- نصوص العقد داخل الرسمة قصيرة جداً (1-3 كلمات) وبالإنجليزية فقط، لأن النصوص العربية الطويلة تتداخل وتكسر الرسمة.
- ممنوع الأقواس () أو علامات الاقتباس داخل نصوص العقد.
- أقصى عدد للعقد 8. الشرح المفصل يكون في الكلام خارج الرسمة، لا داخلها.

# 9. قواعد عامة
- إذا أخطأ: لا تعطه الحل مباشرة، أعد الشرح بزاوية مختلفة ثم اسأل سؤالاً أبسط يبني نحو الفكرة. إذا قال "ما فهمت": غيّر الأسلوب كلياً.
- لا تجامل: الخطأ خطأ، قله بلطف ووضوح.
- إذا رصدت حدثاً مهماً عن تعلم الطالب (مثل: حفظ بدون فهم في نقطة، تحسن واضح، تكرار نفس نوع الخطأ)، صفه بجملة قصيرة في حقل event.

# 10. وسم التقدم — إلزامي في نهاية كل رسالة
أنهِ كل رسالة بسطر واحد بهذا الشكل بالضبط (يُخفى عن الطالب):
<progress>{"covered": [أرقام النقاط المُتقنة], "current": رقم النقطة الحالية, "weak": [أرقام نقاط ضعيفة أو مهددة], "alert": "نص الفجوة المكتشفة أو null", "style": "ملاحظة أسلوب التعلم أو null", "tip": "نصيحة اختبار من سطر أو null", "event": "حدث تعلم مهم أو null"}</progress>
"""

EXAM_PROMPT = """أنت "فاهِم" في وضع الممتحن. انتهى الشرح، والآن تختبر جاهزية الطالب في المنهج المرفق (قائمة النقاط في بداية المحادثة).

البروتوكول:
1. اطرح سؤالاً واحداً في كل رسالة، بإجمالي 10 أسئلة تغطي أوسع قدر من نقاط المنهج، بتدرج: 3 سهلة، 3 متوسطة، 2 صعبة، 2 خادعة (سؤال يبدو بسيطاً لكن فيه فخ شائع أو افتراض خاطئ).
2. بعد كل إجابة: قيّمها بصراحة (صحيحة / جزئية / خاطئة) مع تصحيح موجز جداً، ثم انتقل فوراً للسؤال التالي. لا شرح مطول في وضع الاختبار.
3. اذكر رقم السؤال في كل مرة (مثال: "السؤال 4 من 10 — مستوى متوسط").
4. ممنوع إعطاء تلميحات أثناء الاختبار.
5. بعد السؤال العاشر، أصدر تقرير الجاهزية النهائي: نسبة جاهزية من 100 (احسبها: صحيحة=1، جزئية=0.5، الأسئلة الصعبة والخادعة وزنها 1.5)، أقوى المواضيع، أضعف المواضيع، ونصيحة مراجعة محددة.
6. أنهِ رسالة التقرير النهائي فقط بهذا الوسم:
<report>{"readiness": النسبة, "strong": ["موضوع", ...], "weak": ["موضوع", ...], "advice": "نصيحة من سطر أو سطرين"}</report>
وفي بقية الرسائل أنهِ بوسم progress فارغ: <progress>{"covered": [], "current": null, "weak": [], "alert": null, "style": null, "tip": null, "event": null}</progress>
"""

# توجيهات اللغة والنبرة — تُلحق بنهاية برومبت التدريس أو الاختبار حسب اختيار الطالب
LANG_DIRECTIVES = {
    "ar": """
# اللغة والنبرة — التزم بها بدقة
- اشرح بالعامية السعودية البيضاء: بسيطة، ودودة، واضحة — زي ما يشرح لك صديق فاهم. أمثلة على النبرة: "خلنا نبسّطها"، "تخيل إن عندك"، "طيب وش يصير لو"، "هنا الزبدة".
- الأهم: النبرة متّسقة من أول الرسالة لآخرها. ممنوع منعاً باتاً خلط تراكيب الفصحى الرسمية (مثل: "علاوة على ذلك"، "ومن الجدير بالذكر"، "حيث أن"، "لذا فإن") مع العامية في نفس الكلام — هذا الخلط يطلع مضحك ومشتت.
- التعريفات العلمية الدقيقة والمعادلات تنكتب صحيحة بمصطلحاتها، لكن الشرح اللي حولها كله بنفس النبرة العامية البسيطة.
- المصطلحات التقنية تبقى بالإنجليزية (مثل Gradient Descent, Overfitting) مع شرح معناها بالعامية أول مرة.
- أسئلة الفهم والاختبار بنفس النبرة.""",
    "en": """
# Language and tone — follow strictly
- Respond entirely in clear, friendly English: explanations, examples, scenarios, comprehension questions, and exam questions.
- Keep the tone warm and conversational, like a sharp friend tutoring you — not a formal textbook.
- Scenarios can still reference Saudi/Gulf contexts when helpful (riyals, local examples) since the student is Saudi.
- Never mix Arabic into explanations unless the student switches to Arabic themselves.""",
}

GOAL_DIRECTIVES = {
    "study": """
# الهدف: مذاكرة أول مرة
الطالب يشوف هذا المنهج أول مرة. اشرح كل نقطة كاملة من الصفر بالبروتوكول المعتاد.""",
    "review": """
# الهدف: مراجعة
الطالب درس هذا المنهج من قبل وجاي يراجع. اقلب الأسلوب: ابدأ كل نقطة بسؤال استرجاع مباشر بدون شرح مسبق. إذا جاب الإجابة صح وبثقة، أكد عليها بسطر واحد وعلّمها مُتقنة وانتقل بسرعة (يكفي سؤال واحد في المراجعة للنقاط القوية). إذا تعثر أو تردد، افتح النقطة واشرحها بالبروتوكول الكامل مع التحقق المزدوج. وقت الطالب يجب أن يذهب للنقاط المكسورة فقط.""",
}

PACE_DIRECTIVES = {
    "relaxed": """
# الوتيرة: مرتاح
الطالب عنده وقت كافٍ. تعمّق براحتك في الشروح والأمثلة والسيناريوهات.""",
    "fast": """
# الوتيرة: مستعجل — وضع التغطية المكثفة
وقت الطالب ضيق. التزم بالتالي:
- صنّف النقاط ذهنياً حسب الأهمية: النقاط التي تعتمد عليها نقاط كثيرة (حسب needs) والمفاهيم المحورية = أساسية، والباقي = ثانوية.
- النقاط الأساسية: شرح مختصر ومركّز (نصف الطول المعتاد) مع مثال واحد فقط، وسؤال تحقق واحد بدل اثنين.
- النقاط الثانوية: مرور سريع في فقرة واحدة مع أهم ما فيها، وسؤال سريع، ولا تحذفها من المسار أبداً.
- أكثر من نصايح الاختبار (tip) في هذا الوضع لأن الطالب غالباً قريب من اختباره.
- كن صريحاً في تقرير الجاهزية لاحقاً أن التغطية كانت مكثفة لا متعمقة.""",
}

EXTRACT_PROMPTS = {
    "ar": """اقرأ المادة التعليمية المرفقة بعناية واستخرج قائمة كاملة بكل النقاط والمفاهيم التي يجب فهمها، بدون استثناء، مرتبة بالترتيب المنطقي للتعلم.

لكل نقطة حدد المتطلبات السابقة (needs): أرقام النقاط السابقة في نفس القائمة التي يجب فهمها أولاً لفهم هذه النقطة (قائمة فارغة إذا كانت مستقلة).

أجب بـ JSON فقط بدون أي نص آخر وبدون أقواس Markdown:
{"title": "عنوان المادة بالعربية", "topics": [{"name": "اسم النقطة بالعربية مع إبقاء المصطلح التقني بالإنجليزية (3-8 كلمات)", "needs": [1, 2]}, ...]}""",
    "en": """Read the attached learning material carefully and extract a complete list of every point and concept the student must understand, with no omissions, ordered logically for learning.

For each point, identify prerequisites (needs): the numbers of earlier points in this same list that must be understood first (empty list if independent).

Reply with JSON only, no other text and no Markdown fences:
{"title": "Material title in English", "topics": [{"name": "Point name in English (3-8 words)", "needs": [1, 2]}, ...]}""",
}


class ChatRequest(BaseModel):
    user_id: str
    course_id: str
    message: str


class CourseRef(BaseModel):
    user_id: str
    course_id: str


def _call_llm(messages, system=None, max_tokens=MAX_TOKENS):
    try:
        response = client.messages.create(
            model=MODEL, max_tokens=max_tokens,
            **({"system": system} if system else {}),
            messages=messages,
        )
    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail=f"خطأ من واجهة النموذج: {e}")
    return "".join(b.text for b in response.content if b.type == "text")


def _extract_tag(text: str, tag: str):
    """يفصل وسم JSON عن النص المعروض، يرجع (النص بدون الوسم، الكائن أو None)."""
    if f"<{tag}>" not in text:
        return text, None
    before, _, rest = text.partition(f"<{tag}>")
    raw, _, after = rest.partition(f"</{tag}>")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None
    return (before + after).strip(), parsed


def _public_state(course: dict) -> dict:
    """حالة الشابتر التي تُرسل للواجهة — بدون المستند وسجل API الخام."""
    return {
        "course_id": course["course_id"],
        "title": course["title"],
        "topics": course["topics"],
        "covered": course["covered"],
        "weak": course["weak"],
        "insights": course["insights"],
        "display": course["display"],
        "mode": course["mode"],
        "lang": course["lang"],
        "messages_left": MAX_MESSAGES_PER_SESSION - course["message_count"],
    }


@app.get("/")
def index():
    return FileResponse("static/index.html")


@app.get("/api/courses")
def list_courses(user_id: str):
    folder = DATA_DIR / _check_id(user_id, "user")
    items = []
    if folder.exists():
        for path in folder.glob("*.json"):
            try:
                c = json.loads(path.read_text(encoding="utf-8"))
                total = len(c.get("topics", [])) or 1
                items.append({
                    "course_id": c["course_id"],
                    "title": c.get("title", "شابتر"),
                    "progress": round(len(c.get("covered", [])) / total * 100),
                    "topics_count": total,
                    "mode": c.get("mode", "teach"),
                    "updated": c.get("updated", 0),
                })
            except (json.JSONDecodeError, KeyError, OSError):
                continue
    items.sort(key=lambda x: x["updated"], reverse=True)
    return {"courses": items}


@app.get("/api/course")
def get_course(user_id: str, course_id: str):
    return _public_state(_load_course(user_id, course_id))


@app.post("/api/course/delete")
def delete_course(req: CourseRef):
    path = _course_path(_check_id(req.user_id, "user"), _check_id(req.course_id, "course"))
    if path.exists():
        path.unlink()
    return {"ok": True}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), lang: str = Form("ar"),
                 goal: str = Form("study"), pace: str = Form("relaxed"),
                 user_id: str = Form(...)):
    _check_id(user_id, "user")
    lang = lang if lang in ("ar", "en") else "ar"
    goal = goal if goal in ("study", "review") else "study"
    pace = pace if pace in ("relaxed", "fast") else "relaxed"

    folder = DATA_DIR / user_id
    if folder.exists() and len(list(folder.glob("*.json"))) >= MAX_COURSES_PER_USER:
        raise HTTPException(status_code=429, detail="وصلت للحد الأقصى من الشابترات، احذف شابتر قديم أولاً")

    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"حجم الملف يتجاوز {MAX_UPLOAD_MB}MB")

    filename = (file.filename or "").lower()
    if filename.endswith(".pdf"):
        document_block = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf",
                       "data": base64.b64encode(data).decode()},
        }
    elif filename.endswith((".txt", ".md")):
        document_block = {"type": "text",
                          "text": "المادة التعليمية:\n\n" + data.decode("utf-8", errors="replace")}
    else:
        raise HTTPException(status_code=400, detail="الملفات المدعومة: PDF أو TXT أو MD")

    raw = _call_llm(
        [{"role": "user", "content": [document_block, {"type": "text", "text": EXTRACT_PROMPTS[lang]}]}],
        max_tokens=2500,
    ).replace("```json", "").replace("```", "").strip()

    try:
        parsed = json.loads(raw)
        title = parsed.get("title", "المادة")
        topics = []
        for t in parsed.get("topics", [])[:60]:
            if isinstance(t, dict):
                topics.append({"name": str(t.get("name", "")),
                               "needs": [int(n) for n in t.get("needs", []) if isinstance(n, (int, float))]})
            else:
                topics.append({"name": str(t), "needs": []})
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=502, detail="تعذر استخراج نقاط المنهج، جرّب ملفاً آخر")

    if not topics:
        raise HTTPException(status_code=422, detail="لم أجد محتوى تعليمياً واضحاً في الملف")

    listing = "\n".join(
        f"{i + 1}. {t['name']}" + (f" (تعتمد على: {', '.join(map(str, t['needs']))})" if t["needs"] else "")
        for i, t in enumerate(topics)
    )
    course = {
        "course_id": uuid.uuid4().hex,
        "title": title,
        "document": document_block,
        "topics": topics,
        "topics_listing": listing,
        "history": [],
        "display": [],
        "covered": [],
        "weak": [],
        "insights": {"style": None, "tips": [], "gaps": [], "events": [], "report": None},
        "mode": "teach", "lang": lang, "goal": goal, "pace": pace,
        "message_count": 0,
        "created": time.time(),
    }
    _save_course(user_id, course)
    return _public_state(course)


@app.post("/api/exam")
def start_exam(req: CourseRef):
    course = _load_course(req.user_id, req.course_id)
    course["mode"] = "exam"
    _save_course(req.user_id, course)
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest):
    course = _load_course(req.user_id, req.course_id)
    if course["message_count"] >= MAX_MESSAGES_PER_SESSION:
        raise HTTPException(status_code=429, detail="وصلت للحد الأقصى من الرسائل في هذا الشابتر")

    message = req.message.strip()[:4000]
    if not message:
        raise HTTPException(status_code=400, detail="الرسالة فارغة")

    if not course["history"]:
        course["history"].append({"role": "user", "content": [
            course["document"],
            {"type": "text", "text": "قائمة نقاط المنهج المستخرجة مع اعتمادياتها:\n"
                                     + course["topics_listing"]
                                     + "\n\nرسالة الطالب الأولى: " + message},
        ]})
    else:
        course["history"].append({"role": "user", "content": message})

    if course["mode"] == "teach":
        system = (TEACH_PROMPT
                  + GOAL_DIRECTIVES[course.get("goal", "study")]
                  + PACE_DIRECTIVES[course.get("pace", "relaxed")]
                  + LANG_DIRECTIVES[course.get("lang", "ar")])
    else:
        system = EXAM_PROMPT + LANG_DIRECTIVES[course.get("lang", "ar")]

    reply = _call_llm(course["history"], system=system)
    course["history"].append({"role": "assistant", "content": reply})
    course["message_count"] += 1

    visible, progress = _extract_tag(reply, "progress")
    visible, report = _extract_tag(visible, "report")

    # تحديث الحالة على الخادم حتى تبقى بعد إغلاق المتصفح أو إعادة تشغيل السيرفر
    ins = course["insights"]
    if progress:
        covered = set(course["covered"]) | {int(n) for n in progress.get("covered", []) if isinstance(n, (int, float))}
        course["covered"] = sorted(covered)
        course["weak"] = sorted({int(n) for n in progress.get("weak", []) if isinstance(n, (int, float))} - covered)
        if progress.get("style"):
            ins["style"] = progress["style"]
        if progress.get("alert"):
            ins["gaps"].append(progress["alert"])
        if progress.get("tip"):
            ins["tips"].append(progress["tip"])
        if progress.get("event"):
            ins["events"].append(progress["event"])
    if report:
        ins["report"] = report

    # سجل العرض لإعادة بناء المحادثة عند فتح الشابتر لاحقاً
    course["display"].append({"t": "user", "x": message})
    if progress and progress.get("alert"):
        course["display"].append({"t": "gap", "x": progress["alert"]})
    course["display"].append({"t": "bot", "x": visible})
    if progress and progress.get("tip"):
        course["display"].append({"t": "tip", "x": progress["tip"]})
    if report:
        course["display"].append({"t": "report", "x": report})

    _save_course(req.user_id, course)

    return {
        "reply": visible,
        "progress": progress,
        "report": report,
        "covered": course["covered"],
        "weak": course["weak"],
        "insights": ins,
        "messages_left": MAX_MESSAGES_PER_SESSION - course["message_count"],
    }


app.mount("/static", StaticFiles(directory="static"), name="static")
