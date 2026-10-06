# Java Interview Flashcards

A static flashcard review page for Java interview preparation.

## Use the cards

Open the published page and choose a topic or search for a question. Each card has a prompt, a concise answer, and a detailed answer. Mark important cards with the star button to collect them in the starred set.

Learning progress is stored in the current browser. Use **Export backup** and **Import backup** in the progress panel to move proficiency and starred-card marks between browsers. Import updates matching cards and keeps their question and answer content unchanged.

## GitHub Pages

This repository is published from the `main` branch root with GitHub Pages. The site consists of static HTML, CSS, JavaScript, and JSON files.

The local source project keeps the review layout in `review.html`, `review.css`, and `review.js`. Run `npm run sync:review` there to update this deployment folder and merge the local card content into the published library. Newer source files take precedence for matching cards; personal proficiency and stars are excluded from the shared library. A content version lets returning visitors receive updated answers while retaining their own proficiency and stars.
