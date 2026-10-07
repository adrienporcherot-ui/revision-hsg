# HSG Revision

A static revision website for the HSG Assessment Year: plain HTML, CSS and JavaScript, with no server and no build step.

- **Home**: one card per course with a live countdown to the exam (dates are editable).
- **Flashcards** with spaced repetition. You rate each card *hard*, *medium* or *easy*, and hard cards come back more often.
- **Quizzes** (multiple choice). You see the correct answer and an explanation after each question and your score at the end. You can also retry your mistakes.
- **Summary sheets** that are easy to read and can be printed or saved as PDF.
- **Progress**: % of cards mastered and quiz score history per course.
- Light/dark mode (follows your system by default) and works on mobile.
- Progress is saved in your browser (`localStorage`). Use *Settings → Export / Import* to move it between devices.

## Project structure

```
index.html            the app (single page)
css/style.css         styles (light + dark theme)
js/app.js             logic: routing, spaced repetition, quiz, progress
data/courses.json     list of courses + default exam dates
data/<course>.json    content of one course (flashcards, quiz, summary)
cours/<course>/       your course PDFs (source material, not used by the site)
```

## Adding or editing content

Each course has its own file in `data/`, e.g. `data/economics.json`:

```json
{
  "course": "economics",
  "title": "Economics A: Microeconomics I",
  "placeholder": false,
  "flashcards": [
    { "topic": "1.1 First Principles", "front": "Question", "back": "Answer" }
  ],
  "quiz": [
    {
      "topic": "2.1 Supply and Demand",
      "question": "Question text?",
      "options": ["A", "B", "C", "D"],
      "answer": 1,
      "explanation": "Why B is correct."
    }
  ],
  "summary": [
    { "title": "Section title", "content": ["## Heading", "- bullet with **bold**", "", "| a | b |", "|---|---|", "| 1 | 2 |"] }
  ]
}
```

- `answer` is the **index** of the correct option, counting from 0 (`0` = first option).
- `topic` is optional. It lets you filter flashcards and quizzes by chapter.
- Use `\n` in a flashcard's `back` text to start a new line.
- Summary `content` is a list of lines in simple Markdown: `#`/`##`/`###` headings, `-` bullets, `1.` numbered lists, `**bold**`, `*italic*`, `` `code` ``, `>` callouts and `|` tables.
- Once you replace a sample course with your own material, set `"placeholder": false` to remove the "Sample content" badge.
- Your progress on a card is linked to its question text (`front`). If you edit a question, that card starts again from zero. You can avoid this by giving the card a fixed `"id": "any-unique-text"`.
- Default exam dates are in `data/courses.json` (`YYYY-MM-DD`). Dates you change on the site are stored in your browser and take priority.

Current status: **Economics** was generated from the PDFs in `cours/economics/` (Part 0, Parts 1.1, 1.2 and 2.1). The other seven courses have **sample content** to replace. Put their PDFs in `cours/<course>/` and update `data/<course>.json`.

## Running it locally

Browsers block `fetch()` of local files, so double-clicking `index.html` won't load the data. Start a tiny server in this folder instead:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Publishing for free with GitHub Pages

1. Make sure the site files are on your default branch (`main`). If they are on another branch, open a pull request and merge it.
2. On GitHub, open the repository and go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Select branch **`main`**, folder **`/ (root)`**, then click **Save**.
5. Wait 1–2 minutes and reload the page. The address appears at the top: `https://<your-username>.github.io/revision-hsg/`.

Every push to `main` then updates the site automatically. On a free GitHub account, Pages requires the repository to be **public**. Note that everything in the repository is then publicly reachable, including the PDFs in `cours/`.
