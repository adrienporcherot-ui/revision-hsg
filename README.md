# HSG Revision

A static revision website for the HSG Assessment Year: plain HTML, CSS and JavaScript, with no server and no build step. All content comes from the lecture PDFs only.

- **Courses**: each course is split into **chapters**. Every chapter has:
  - a **Summary** (Big Picture · Key Concepts with *Simple* and *Exam* layers plus an example · Connections · Exam Focus · Definitions/Formulas to Memorize · what's unclear or missing in the PDFs);
  - **Practice**: multiple-choice questions (4 options, one correct, answer and explanation after each question);
  - a **Mock exam** (HSG style, 30 min).
- **Mock exams**: one per chapter plus one for the whole course. You get a visible 30-minute timer that never blocks submission, and no hints during the exam. MC questions are auto-graded. For open questions and calculations you see the model answer and key points and grade yourself strictly. You get a Swiss grade (1 + 5 × points/total, rounded to 0.25; 4 = pass), weak topics linked to the summary, and a **Copy my answers** button.
- **Today**: a daily to-do list built from what you haven't done yet, your lowest grades and your weak topics. You can tick off tasks, and the list renews every day.
- **Progress**: grades, practice scores and chapters read per course.
- Light/dark mode, works on mobile. Progress is saved in your browser (`localStorage`); use *Settings → Export / Import* to move it between devices.

## Your PDFs stay private

The lecture PDFs are **not** in this repository and never on the published site. `.gitignore` blocks `*.pdf`, `*.zip` and the course folders, so they cannot be committed here by accident.

The PDFs live in the **private** repository **`revision-hsg-cours`**, sorted by course:

```
cours/
  mathematics/  political-science/  history/  business-administration/
  economics/    organisation/       german/   financial-accounting/
  private-law/
```

### Adding new PDFs later

1. Open the **private** repository `revision-hsg-cours` on GitHub (not this one).
2. Go into `cours/<course>/` and use **Add file → Upload files**. You can upload into a new sub-folder if you like.
3. Start a Claude Code session with **both** repositories and ask it to update the course from the new PDFs. It will write the summaries, practice questions and mock exams into `data/` here. Only that generated text gets published.

Never upload PDFs to `revision-hsg`: it is public, and everything in it is reachable on the web.

## Project structure

```
index.html                    the app (single page)
css/style.css                 styles (light + dark theme)
js/app.js                     routing, summaries, practice, mock exams, Today, progress
data/courses.json             list of courses (id, name, icon, colour)
data/<course>/course.json     course info, chapter list, whole-course mock exam
data/<course>/<chapter>.json  one chapter: summary, practice, mock
```

A course without a `data/<course>/` folder is shown as “No PDFs yet” (currently History, Organisation and Financial Accounting).

## Chapter file format

```json
{
  "id": "1",
  "number": "1",
  "title": "Chapter title",
  "sources": ["Lecture 1 slides"],
  "summary": {
    "bigPicture": ["3–5 bullets"],
    "concepts": [
      { "id": "concept-id", "name": "Concept", "slides": "Slides 4–6",
        "simple": "Explained to a 12-year-old", "exam": "Formal definition / formula (Markdown, string or list of lines)",
        "example": "One concrete example" }
    ],
    "connections": ["…"],
    "examFocus": { "questions": ["…"], "traps": ["…"], "mistakes": ["…"] },
    "memorize": ["…"],
    "gaps": ["Anything unclear or missing in the PDFs"]
  },
  "practice": [
    { "topic": "concept-id", "question": "…", "options": ["A", "B", "C", "D"], "answer": 1, "explanation": "…" }
  ],
  "mock": {
    "questions": [
      { "type": "mc", "points": 2, "topic": "concept-id", "question": "…", "options": ["A", "B", "C", "D"], "answer": 0, "explanation": "…" },
      { "type": "open", "points": 6, "topic": "concept-id", "question": "…", "model": "Model answer",
        "keyPoints": [ { "text": "Key point", "points": 3 }, { "text": "Key point", "points": 3 } ] },
      { "type": "calc", "points": 6, "topic": "concept-id", "question": "…", "model": "…", "keyPoints": [ … ] }
    ]
  }
}
```

- `answer` is the **index** of the correct option, counting from 0.
- `topic` must be the `id` of a concept in the same chapter. It powers the weak-topic list and the “Review” links.
- For open and calc questions, the `keyPoints` points must add up to `points`.
- `course.json` has `title`, `info` (Markdown lines), `chapters` (list of chapter ids) and `courseMock.questions`. Course-mock questions also carry `"chapter"`.
- Text supports simple Markdown: headings, `-` bullets, `1.` lists, `**bold**`, `*italic*`, `` `code` ``, `>` callouts and `|` tables.

## Running it locally

Browsers block `fetch()` of local files, so start a small server in this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Publishing with GitHub Pages

1. On GitHub, open this repository → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**, branch **`main`**, folder **`/ (root)`**, then **Save**.
3. After 1–2 minutes the site is at `https://<your-username>.github.io/revision-hsg/`.

Every push to `main` updates the site. Pages is free for public repositories. The site only contains the generated summaries and questions, never the PDFs.
