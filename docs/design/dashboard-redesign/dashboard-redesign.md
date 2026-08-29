# Dashboard UI — design notes

**What this is.** A source note. It records two external videos on dashboard UI in full
detail, so the decisions are reusable without re-watching.

**What this is NOT.** It is not a RepWorth decision record. It states no RepWorth token,
route, or component. It contradicts nothing in `docs/design/console/DESIGN.md`. Treat it
as input to a Console redesign, not as the redesign.

## The two sources

| | Source A | Source B |
|---|---|---|
| Title | "EVERYTHING you need to know to build a Dashboard UI in 8 minutes (beginner friendly)" | "I Studied 2,108 Dashboards To See What Sticks" |
| Author | Kole Jain | Mobbin |
| Date / length | 2025-08-30 · 8:23 | 2026-05-05 · 5:07 |
| URL | `youtube.com/watch?v=B7k5rOgmOGY` | `youtube.com/watch?v=kdRkuqu8apE` |
| Type | Build tutorial | Pattern research |
| Question it answers | How do I lay one out? | Why do some stick? |
| Extras | Free Figma files at `kolejain.com/resources` | Data source `mobbin.com` |

The two do not overlap. Source A gets you to a correct dashboard. Source B argues that a
correct dashboard is forgettable, and names what to add. Read A, then B, then Part 3.

**Note on evidence quality.** Both videos were captured at 360p. Layout, structure and
copy are reliable. A few small chart numbers in Source B were not legible; those are
marked in place.

---
---

# Part 1 — Building a dashboard (Source A)

**Worked example.** A link-shortener and link-tracking app, "Kangaroo Inc.", on the domain
`linkd.sh`. It is a Dub clone. It is dark mode. It is built in Figma.

**Sponsor segment:** 4:12–4:40 (Mobbin — the author of Source B).

**Thesis (0:02).** Most portfolio dashboards fail. The cause is disorder, not ugliness.
The target is three things at once: simple, aesthetic, usable.

## 1. The sidebar (0:21–1:40)

The sidebar is the spine of the product. It holds every element that is persistent and
globally relevant. Three element classes belong there: navigation, profile management,
and search. Profile management and search may move to a top bar instead.

Sidebars are hard to get wrong. Dashboards are not. Spend the saved effort on the main
region.

### Build order, top to bottom

1. **Put profile management at the top, not a logo.** A logo wastes the most convenient
   spot. A profile picture gives fast identity. A chevron pair signals that the row is
   clickable and opens an account switcher.
2. **Give every nav link an icon plus a short title.** The icon lets the sidebar collapse
   to an icon rail without losing meaning. The short title leaves room to the right.
3. **Reserve that right-hand room for status.** A notification count or a `New` chip fits
   there. The video shows `Customers 6` and `Partners [New]`.
4. **Group links by relevance.** Grouping is the whole point of navigation. Navigation
   exists to reduce cognitive load.
5. **Send rare links to the bottom.** Settings and Help Center are rarely used. They dock
   at the base of the sidebar, separated from the main group.
6. **Nest links into dropdowns as the count grows.** A flat list stops working past a
   certain length. The video nests under `Customers`.
7. **Give links an active state.** This is not optional. The video uses a filled rounded
   rectangle behind the current link.
8. **Optional — add search or feature entries** near the nav group if you want to
   highlight them.
9. **Optional — fill the leftover empty space with a promo card.** Dub and Linear already
   do this. The video's card reads: `New` chip, title "Partners affiliate program", one
   line of body copy, and a `Try it out ↗` button, with a dismiss `×`.

## 2. The main dashboard region (1:40–4:40)

### The anti-pattern (1:45)

A bad dashboard "feels like someone emptied a drawer onto the screen". The test the video
gives: if the dashboard looks like it requires a PhD to operate, it is too complex.

The rule that replaces it: **do one thing well with your dashboard.**

### Three considerations before laying anything out

**1. Dashboard elements are much smaller than landing-page elements.**
You are fitting many more things into the same screen. The video shows both type scales
side by side (2:10):

| Level | Landing page | Dashboard |
|---|---|---|
| h1 | 125 px | 20 px |
| h2 | 24 px | 16 px |
| h3 | 18 px | 14 px |
| h4 | 12 px | 12 px |
| h5 | — | 10 px |

Two properties matter, not just the absolute size:
- The sizes are small.
- The **steps between sizes are small**. The landing scale jumps 125 → 24. The dashboard
  scale steps 20 → 16 → 14 → 12 → 10.

**2. Follow the grid strictly.** Grids and layouts are followed far more strictly on a
dashboard than on a landing page. The reason is that a dashboard uses most or all of the
space on screen, so any drift is visible.

**3. The main region states what matters most to the user.** What you put in the main
section reflects the user's top priority. Examples given:
- Project management tool → show project status.
- Financial tool → show investments right at the top.

### The layout built in the video

- A simple **two-column, two-row grid**.
- Top row: link management (the primary object).
- Bottom row: two metric cards.

### The page top bar

The very top of the dashboard is reserved for **important page actions or simple
navigation**. For this relatively simple dashboard that means:

- A `Links` page title with a dropdown chevron (simple navigation).
- A `Create Link` primary button (the important page action).
- A `Display` control and a `Settings` control.
- A `Search links` field on the right.

### The primary list

Keep displayed data on the home page **super simple**. The chosen row fields are:

1. Favicon of the destination site.
2. The shortened link (`Linkd.sh/hKWhPa`), with a copy icon.
3. The destination link (`mywebsite.com/blogposts`).
4. Age (`7m`, `10d`).
5. A click count on the right (`27 clicks`), with a status dot.

There is still open space in the middle of the row. Fill it with a **brief description**
— the video cites GitHub as the model (`IG conversion funnel #2`, `Pinterest blog post
links`).

**Separation choice.** Two options, and the video picks the second:
- Give each link its own border, for strong visual separation.
- Stack them into a plain list, for less clutter. **Chosen.**

**Two consequences of the list choice:**
- The list layout makes an **empty state** easier to add when there are no links. The
  video calls empty states important and frequently forgotten.
- The rows can carry a selection affordance (below).

**Micro-interaction (3:23–3:40).** A static list is not enough for real applications,
because real users must manage data efficiently. Let the user select multiple rows. That
selection **reveals a new contextual button, `Bulk Actions`**, in the toolbar. The button
does not exist until the selection exists.

### The charts

**Do not invent chart shapes.** The video shows a "Sales Report" card of overlapping
pastel blob curves and says plainly: "I don't know what these are, and neither does
anyone else."

**Chart 1 — line graph.** Build it in this order:
1. Start with a basic line graph.
2. Add grid lines and axis numbers. "Everyone forgets those."
3. Add a summary figure above it: `Total clicks: 352`.
4. Add a date-range selector: `1d 1w 1m 6m 1y`.

**Chart 2 — bar chart.** Break the same data down per link.
1. One horizontal bar per link, with the value at the right (`124`, `86`, `51`, `46`, `21`).
2. Put the **favicon beside each bar** so the rows are identifiable at a glance.
3. Add the same range selector.
4. Add tabs to switch the measure: `Clicks | Signups | Conversions`.

The closing line: there is no reason a chart cannot be simple, informative **and**
aesthetic at the same time.

## 3. Modals, popovers and new pages (4:40–5:52)

This is where dashboard function actually lives. The layout built so far displays a lot
of information but cannot do anything.

### The decision table

| Surface | Use when | Blocking? | Example in the video |
|---|---|---|---|
| **Popover** | The context is simple | **No.** The user can click away with no consequence. | The `Display` panel: `Cards/List` toggle, `Ordering: Date created`, `Archived Links` switch |
| **Modal** | The context is more complex, but you want the user to stay on the same page | **Yes.** The user must click Create or Cancel before dealing with anything else. | The `New Link` form |
| **New page** | The context is more permanent, or very large | n/a | Clicking through to one existing link's detail view |

**Why the modal is correct there:** creating a link is directly related to the links
already displayed on screen. Relatedness is the test, not size alone.

**The `New Link` modal's fields**, as a reference for form density: Destination URL,
Short Link (domain select + generated slug + regenerate icon), Tags, Conversion Tracking
(switch), Folder (select), Description (textarea), a row of secondary chips — `UTM`,
`Targeting`, `Expiration`, `Password` — and a primary `Create Link` button. The
breadcrumb `Links > New Link` sits in the modal header with a close `×`.

**The new-page rule:** if you send the user to a new page, a back button or a breadcrumb
is **pretty much required**. The detail page in the video shows `← back`, a `Copy Link`
button, the same form fields now populated, side stat cards (`Clicks: 124`,
`Conversions: 9`) and a `Created by … · Jul 14` footer.

### Toasts

A modal hides the page while the change happens. So **confirm the result with a toast
once it closes**. This is called out as general good practice.

Toasts are the notification system of the dashboard. Use one any time you want to make
the user aware of something **without taking over the entire screen** and without
prompting them to act.

Both arms are shown:
- Success — green dot, "Link created", body "Changes to the short link will take effect
  immediately".
- Failure — red dot, "Link creation failed", body "Please try again or contact Link
  support for help".

The video names **warning and error states** as the ones that frequently get missed.
Empty states and toast error states are the two omissions it flags by name.

## 4. The four dashboard components (5:52–7:24)

Laying out every other page is fairly trivial, because there are really only four main
dashboard components. Master these four and you can build virtually any dashboard page.

### 4.1 Lists and tables

The most common component. The video has already used several: the link list, the link
detail view, and the sidebar itself.

**A good list comes down to separation.** There are exactly three ways to separate:
1. Space.
2. Lines or dividers.
3. Color.

**A good table is about function, not separation.** Displaying the data is only half the
battle. Give the user **search, filter and sort**. Those three turn a static table into an
interactive tool.

### 4.2 Cards

Cards include the charts and the toast notifications. Most dashboards are made of many
cards together.

- **Keep the margins well spaced** so content is not too tightly packed.
- **Choose a border or a background color** — one or the other, not both.
- Stated preference: **outlines in dark mode, background colors in light mode.** The video
  marks this as personal taste, not a rule.

### 4.3 User input

Already used in the link modal. Every settings page is made of these. The video shows a
generic settings panel: a left rail (`General / Profile / Security / Notifications /
Subscription`) against a right pane of label-plus-control rows — text with an edit pencil,
a disabled email row, three toggles, and a select.

The example held up as the good case: **Vercel** — tables with forms inside cards.

### 4.4 Tabs

Tabs are fantastic for **adding new pages without cluttering the sidebar**.

The example is **Notion**: tabs give different views of very related tables without
leaving the context of the page.

The video then decomposes Notion's own settings modal to prove the taxonomy closes:
it is mostly **lists**, with some **user inputs**, and some **cards** once you reach the
Connections section — all of it **inside a modal**.

## 5. Micro-interactions and motion (7:24–8:03)

Animation and interaction on dashboards is **tame and user-focused** compared to websites
and landing pages. That is the default posture.

**Charts are the exception.** This is where you can be a little more creative. Two
concrete examples:
- Line chart hover → show the value **and** a small percentage-change bubble beside it,
  with a vertical guide line down to the axis label.
- Bar chart hover → **dim all the other bars**, isolating the hovered one.

**Optimistic UI.** What everyone actually wants is a snappy, fast dashboard. The mechanism
is optimistic UI: apply the change in the interface immediately and assume the server
request will succeed.

The example is Gmail: deleting an email removes it instantly. The app is *optimistic* that
the request will succeed. Without it you get an awkward pause before the row disappears.

---
---

# Part 2 — What makes a dashboard stick (Source B)

**Format.** Research, not tutorial. The author reviewed a corpus and reports patterns.

**Stated aim.** Skip the usual advice on spacing, grids and visual polish. Find the deeper
patterns behind dashboards that actually stick.

## 6. The dataset, and why dashboards matter commercially

### 6.1 The corpus

Shown on screen at 0:16:

- **2,108** dashboard screens
- across **536** apps and websites
- across **19** categories (about **30** screens each)
- snapshot: **April 2026**
- source: `mobbin.com`

The video's own chart deck has seven pages, visible in its left rail: **Top Searches,
Top Filters, By Platform, By Category, Engagement by Category, Composition, Most
Popular.** The video shows four of them.

### 6.2 Demand — dashboards are the most-wanted reference

Two charts establish that designers want dashboards more than any other screen.

**Top Searches on Mobbin.** "Dashboard" is the **#1 free-text search term** on the whole
site. Rendered as a donut of share-of-all-free-text-searches.

**Top screen pattern filtered on Web.** "Dashboard" leads at **3.27×** the next pattern.
Full ranking as shown:

1. **Dashboard** ← 3.27× the next
2. Filter & Sort
3. Login
4. Home
5. Signup
6. Settings & Preferences
7. Chat Bot
8. My Account & Profile
9. Charts
10. Notifications

### 6.3 Why designers want them

Her explanation is generated live, by asking Claude on her phone at 0:22:

> "Dashboards are the designer's gym selfie. Visually impressive, complex enough to flex,
> and fits perfectly in one screenshot."

### 6.4 The setup — why "fine" is not enough

At 0:36 she shows a generic light-mode SaaS dashboard and annotates it in orange
handwriting with the four things every tutorial teaches:

- **VISUAL HIERARCHY**
- **WHITESPACE**
- **USEFUL CHARTS**
- **CONSISTENT GRID**

Her verdict: "These are perfectly fine dashboards." Then the question that drives the
entire video:

> **"But if I close this right now, would you remember any of them?"**

This is the hinge between the two sources. That annotated screenshot is, in effect, a
summary of Part 1. Source B's argument is that clearing that bar is the **start**.

### 6.5 What a dashboard is made of

The **Dashboard Composition** chart (2:37) measures which patterns co-occur with the
Dashboard tag, counted by unique app, across the 536 apps that have a dashboard. Ranking
as shown, highest first:

1. **Charts** (highest by a clear margin)
2. **Home** (highlighted in the video)
3. My Account & Profile
4. Date & Time
5. Progress
6. Timeline & History
7. Wallet & Balance
8. User / Group Profile
9. Map
10. Achievements & Awards
11. Calendar

Read it as the default parts bin. Charts and Home are near-universal. Everything from
Progress downward is a genre choice, not a requirement.

## 7. The five patterns — the video's real spine

The video carries an on-screen list that builds cumulatively as each section lands. Those
five labels are the actual structure, and they differ from the YouTube chapter names.

| # | On-screen label | YouTube chapter | Timecode |
|---|---|---|---|
| 1 | One step ahead | Anticipation | 0:46 |
| 2 | Broke the mold | Breaking the mold | 1:15 |
| 3 | The dashboard is the pitch | The pitch | 2:08 |
| 4 | Coined their own language | Coining metrics | 3:21 |
| 5 | Answered the "why" | Where dashboards are heading | 3:44 |

## 8. Pattern 1 — One step ahead (0:46–1:15)

The dashboards she returned to do not stop at reporting. They pre-empt the user's next
question and put the answer in the same frame as the data.

**Fey** (stock research). Beside the price chart sits a **Key Indicators** panel of three
plain-language bullets, each with a status dot:

- "Underperforming S&P 500 by **20.47%** YTD"
- "Trading at **4.73%** below estimates"
- "Earnings are forecast to grow **19.58%** per year"

The panel carries tabs — `News` / `KPIs` / `About` — and a timestamp line ("Metrics
analysed at …"). Below the fold: an analyst-rating **radar chart** (Strong Sell / Sell /
Neutral / Buy / Strong Buy) and a **price-target projection** fanning out from the current
price. Under the chart sits a strip of raw figures: FY Revenue $97.69B, EPS $2.21, Gross
Margin 16.26%, Profit Margin 9.01%, Beta 2.33, Div yield N/A, Sector Cons Cyc.

> The rule, stated: **"It doesn't just show you what happened. It shows you what to do
> about it."**

**Origin** (personal finance). The home screen is "Good morning, Sam" plus net worth,
a chart, and a spending calendar. The pattern lives in the **right rail**, a stack of
dismissible cards:

- `COMPLETE ONBOARDING` — "Make the most of Origin", 33% complete, with a progress bar
- `PERSONAL RECAP` — "Your weekly recap", dated
- `PERSONAL BRIEF` — "Daily market brief"
- `BUDGET OF FEBRUARY` — "Budget your money" with a `Start budgeting` button

Opening the recap gives a full-screen **story card**. It leads with the conclusion as a
sentence — *"Your net worth remained stable through a quiet week"* — then the number
($1,072, +0.00%), then the chart, then two short paragraphs of reasoning. It ends with
**`More like this` / `Less like this`** feedback buttons. The market brief works the same
way: a headline ("US PPI data looms over markets"), a paragraph, then three index
sparklines (Dow Jones, S&P 500, NASDAQ) with percentage deltas.

**Runna** (running). After a run, the stats are packaged as shareable **highlight cards**,
not a splits table: "My First Run — Congrats on your Walk-Run session!" with the route
trace, then `Laps` (15 laps, per-lap bars), then `Elevation` (193 m, profile chart). It
first asks "How did you find this workout?" with thumbs-up / thumbs-down to unlock AI
insights.

> "Runna packages your stats into highlights that give you a sense of accomplishment."

## 9. Pattern 2 — Broke the mold (1:15–2:08)

The second pattern is purely visual. Because most dashboards look the same, a different
form is what gets remembered.

**Shopify Live View.** A rotating **dot-matrix globe**. Every dot is a real person
browsing your store somewhere right now. The left rail carries small cards — Visitors
right now, Total sales, Sessions, Orders, Customer behavior (Active carts / Checking out /
Purchased), Sessions by location, New vs returning customers, Total sales by product.
A legend at the bottom right toggles `Orders` and `Visitors right now`.
She then shows the **May 2022 and Aug 2024 versions side by side** to make the point that
Shopify kept investing in it across years and platforms.

**Visitors** (web analytics). A near-empty grey world map with a single red dot and a
small bottom-docked panel (Pages / Referrers / Countries). Her point is inverted from
the others:

> "Most dashboards tend to look busy. Being this clean stands out."

**Front** (shared inbox). A **heat map** replaces a chart. "Busiest times" is a grid of
hour (9 AM–5 PM) × weekday (Mon–Sun); a darker square just means a busier hour. Beside it
a donut labelled "Reply time (avg) 7m 4s" and an Efficiency breakdown (Less than 15min
67%, 15min–40min 33%, 40min–1h 4%, 1h–2h 6%, More than 2h 1%). The key-metrics row above
uses big numbers with green deltas: New conversations 224 (+224), Reply time (avg) 7m 4s,
First reply time (avg) 7m 4s.

**Cake Equity** (cap table). A literal **birthday-cake illustration sits inside the
ownership donut chart**. Around it: Top Stakeholders with percentage bars (Jon Smith
68.42%, Jane Smith 10.52%, Unallocated Options 21.05%), a `Fully Diluted / Undiluted`
toggle, and a left column of plain stats (2 Stakeholders, 30 Total shares, 38 Total
securities, $100 Valuation, $2.63157 Share price).

**Mercury** (banking). The strongest example. Instead of showing an empty table once
every bill is paid, the **empty state is a playable Space Invaders game** — "ALL YOUR
BILLS ARE PAID", `LEVEL: 1`, `SCORE: 0`, `POWER-UPS`, a ship and rows of dollar-sign
invaders.

Her conclusion for the whole section:

> "You can tell these weren't templates. Someone sat down and thought: *how do I actually
> make this data make sense to my users so they get it instantly?*"

Also shown in the same montage: **Plata Card** (a two-tone gradient allocation ring —
Equity / Fixed income / Cash), and **Acorns** ("Your Acorns Potential — $140,911", a
projection bar chart to age 66 with `Years to grow: 40` and `Average return: 8%`).

## 10. Pattern 3 — The dashboard is the pitch (2:08–2:56)

A short etymology section, then the commercial argument. This is the most quotable part
of the video.

### 10.1 Etymology

"Dashboard" originally had nothing to do with data. Nearly **200 years ago** it was a
literal **wooden board on a horse carriage**, used to block mud and horse dung thrown up
when the horse *dashed* forward. As cars replaced carriages, the dashboard became **the
place for signals**. The montage runs: horse carriage → horse hooves kicking up dust →
vintage gauge cluster → Bentley interior → Tesla instrument screen.

> **"The form keeps changing. The job never changed."**

### 10.2 The commercial argument

- Today, **nearly one in five products on Mobbin have their dashboard as the home screen.**
- When a buyer is choosing between Shopify and ten other platforms that do roughly the
  same thing, **the dashboard does a lot of the convincing.**

The definition of the job, and the single most transferable line in either video:

> **"One screenshot that tells you exactly what this product does, how you're doing, and
> what to do next."**

Three clauses. Identity, status, next action. A dashboard that misses any one of them is
not doing the job.

### 10.3 Mobile is where the standouts were

> "A lot of the dashboards that stood out to me were on mobile."

**Opal** (screen time). Screen-time insights are formatted as an **Instagram story**, with
a segmented progress bar at the top and an avatar. You swipe through your own data like
content. Two cards shown:

- "Your most productive day was **Thursday** with **29m** of screen time" over a bar chart
  of the week, then "Your most distracting day was **Wednesday** with **59m**", then a
  "Did you know" tip about scheduling app blocks.
- "When you joined Opal, you were on track to spend … **32 years** … looking down at your
  phone." The number animates through 31 / 32 / 33. Footnote: based on the onboarding
  assessment of 7h daily screen-time average.

Every card carries a **`Share this story`** button at the bottom.

> "When something looks this good, people are bound to share it."

**Orbit** (subscription manager). Subscriptions are rendered as a **planet with orbiting
moons**, one moon per subscription. Below: `3 Personal`, `$0.00 Saved yearly`, a `Get
started guide` row, then Free Trials and Monthly sections listing Spotify, YouTube
Premium and so on.

> "Orbit makes tracking subscriptions weirdly enjoyable."

### 10.4 Same pattern outside the credited list

Two more dashboards appear in this section that are not in the video's credited app list,
and both are worth noting because they are developer-facing:

- **GitHub** — the profile contribution heat map, plus an "Activity overview" radar
  (Code review / Issues / Pull requests / Commits) and a 1,575-contributions counter.
- **A Claude Code usage dashboard** — "What's up next, Rachel?" with an `Overview` /
  `Models` tab pair, an `All / 30d / 7d` range selector, eight stat tiles (Sessions,
  Messages, Total tokens, Active days, Current streak, Longest streak, Peak hour,
  Favorite model) and a contribution-style heat map below.

Both are the same shape: identity, status, streak, next action.

## 11. Pattern 4 — Coined their own language (3:21–3:44)

Some products invent their own metric, and the metric becomes the user's vocabulary. This
is presented as a **retention** argument, not a design one.

- **Duolingo** made **streaks** a thing.
- **Oura** gives a **Readiness Score** — shown as 90, "Optimal", with the line "Rise and
  shine" and a paragraph of interpretation. A Sleep score of 91 sits below it.
- **Apple Fitness** — the decisive example. A user does not say "I worked out for 30
  minutes today." They say **"I closed my rings."** The Summary screen shows the three
  Activity Rings (Move 149/290 kcal, Exercise 31/30 min, Stand 2/10 hrs), then Step Count,
  Step Distance, Sessions, Trainer Tips and Awards.

The consequence:

> "Once that happens, it's very unlikely that this person would change to another fitness
> tracker."

The mechanism is worth stating plainly: **a coined metric is a switching cost.** A user
cannot take "readiness score" or "closed rings" to a competitor, because the competitor
does not have that number. The metric, not the interface, is the lock-in.

Others shown in the same montage, each with its own invented unit:

- **Withings Health Mate** — "Health Improvement Score", 61 out of 100, "your score
  increased by 1 point this week", with Activity / Body / Heart contributors.
- **bless** — a "trends." screen: SGD SPENT 108 / SGD SAVED 6698 / SGD EARNED 300, then
  four coloured blob shapes labelled Want 6, Got 3, Didn't get 3, Got rid of 1.
- **GO Club** — hydration as a filling bottle: 0% Completed, 50 oz Goal, a drag slider to
  add ounces. A companion "Reflect on your today's journey" card shows Steps 1,068,
  Distance 0.46 mi, Calories 20.3, Walking Speed 2.2 mph, plus a mood slider.
- **Nike Run Club**, **Runbuds**, **Flighty** (My Flights over a 3D globe), **Tolan** (an
  avatar planet with Wonder / Orbit / Drive counters and a levelling bar).

## 12. Pattern 5 — Answered the "why" (3:44–4:30)

### 12.1 The gap

> "We've all had a moment staring at a dashboard asking: Why? What changed? What caused
> this spike?"

She backs the framing with a real Reddit thread from **r/BusinessIntelligence**:
*"Is 2026 the year we finally admit the 'Dashboard era' is over?"* — 120+ comments, 127
answers. The top answer visible: "Dashboards being under-utilised isn't an indication that
dashboards are inh…"

That gap is what AI is filling.

### 12.2 Two depths of AI

**Depth 1 — subtle: a single prompt right below the chart.**
**Linktree** puts one small chip under its Activity card: *"How can I get more visitors to
my Linktree?"* Another sits under Monetization: *"How can I earn more with Linktree?"*
One line, in place, at the exact moment the question arises. No panel, no mode switch.

**Depth 2 — a full AI layer you can talk to alongside your data.**

- **Linktree** — a right-hand panel: "Hey there. What would you like to dig deeper on
  today?" with suggested prompts ("How can I drive more traffic to my links?", "What
  topics do my visitors engage with most?", "Any trends I should keep an eye on?"). Asking
  it produces a written "Linktree Summary & Insights (Last 7 Days)" report.
- **Origin** — "Your AI *financial advisor* is ready to help you," with starter chips
  ("Why is my net worth zero?", "Do I have any loans now?", "What debts do I currently
  have?", "How can I build wealth?") and a memory feature ("Try saying 'remember' to save
  a new memory").
- **Midday** — an `Assistant` card docked in the dashboard grid with prompt chips
  ("What's my burn rate", "What's my runway", "Show transactions without receipts",
  "What's my tax summary", "What is my spending on Software"). Clicking one opens a modal
  that answers in place.
- **Evernote** — a floating "Ask questions and get enhanced answers with AI" bar over the
  workspace.
- **ClickUp Brain** — a right panel, "Ask anything or write with AI", grouped into "Ask
  about your tasks" and "Create with AI".

### 12.3 The data that justifies it

> "On Mobbin, AI dashboards get about **twice the saves and exports** of the average
> dashboard screen. It reveals that designers are actively collecting these as
> references."

The **Engagement by Category** chart makes it concrete. Its title reads: *"The most saved
& exported dashboards are **AI, Business & CRM** — ~2× the average dashboard."*

- **Overall average: 293** engagement per screen (marked as a dashed vertical line).
- **AI: 619** engagement/screen — the tooltip shown in the video.
- **Business: 577**
- **CRM** — third; the value was not legible at the available resolution.
- Finance **413**, Crypto/Web3 **412**, Developer Tools **359**
- Health & Fitness **284**, Travel & Transportation **228**, Education **225**,
  Entertainment **198**, Productivity **191**
- Social Networking **166**, Lifestyle **163**, Food & Drink **131**, Shopping **88**,
  Photo & Video **83**, Maps & Navigation **77**, News **78**, Sports **24**

Bars are colour-coded into three families:

| Colour | Family | Where it sits |
|---|---|---|
| Blue | B2B / SaaS / Finance | The entire top of the chart |
| Green | B2C | The middle |
| Red / salmon | Consumer / Content | The bottom |

The shape of that chart is the finding: **B2B dashboards are the ones designers study.**
Sports, at 24, is roughly one twenty-fifth of AI.

## 13. The closing heuristic (4:28–4:45)

One gut check, offered as her entire method:

> **"Would I screenshot this, and why?"**

And the finding it produced:

> "The dashboards that I would screenshot weren't the prettiest ones. They were the ones
> that **knew what to leave out** — and they just happened to look good doing it."

The video closes by trailing the channel's other research: a study of **1,460 onboarding
flows** (headline finding: an effective onboarding flow is **not** about keeping it
short), and a paywall study in production.

---
---

# Part 3 — Combined

## 14. How the two sources relate

| | Source A (Kole Jain) | Source B (Mobbin) |
|---|---|---|
| Method | One worked example, built live | 2,108 screens, 536 apps, counted |
| Unit of advice | A rule you apply | A pattern you copy |
| Covers | Sidebar, grid, type scale, four components, surface choice, motion | Anticipation, form, pitch, coined metrics, AI |
| Where it stops | A correct, competent dashboard | — |
| Where it starts | — | Exactly there |

Read literally, Source B's opening annotation — visual hierarchy, whitespace, useful
charts, consistent grid — **is a summary of Source A**. Source B's whole argument is that
those four are table stakes, and that a dashboard clearing all four is still forgettable.

The practical sequence:

1. Use Source A to get the structure right. Anything below its bar is broken, not bland.
2. Use Source B to decide what makes this dashboard *this product's* dashboard.
3. Apply the screenshot test. If nobody would screenshot it, step 2 did not happen.

**Where they agree, and it is worth noting they arrived independently:**

- Both name the **empty state** as the thing designers skip. Source A says design it.
  Source B shows Mercury turning it into a game.
- Both treat **charts as the place where creativity is allowed**. Source A allows it in
  hover states. Source B allows it in the chart's whole form (globe, heat map, planet).
- Both reject decoration for its own sake. Source A: do not invent chart shapes nobody
  can read. Source B: the memorable ones were not the prettiest.

**Where they differ:**

- Source A says the main region reflects the user's most important object. Source B says
  the dashboard reflects **the product's pitch to a prospect**. Both are true, and they
  can conflict — the most useful screen for a daily user is not always the most
  convincing screen for a buyer. That tension is a real design decision, not an error.

## 15. The rules, compressed

### Structure — from Source A

1. Put persistent, globally relevant elements in the sidebar; it is the spine.
2. Profile management goes at the top of the sidebar, not the logo.
3. Every nav link gets a recognizable icon and a short title.
4. Group nav links by relevance; send rare links to the bottom.
5. Nest into dropdowns once the link count grows.
6. Every nav link needs an active state.
7. Use a small type scale with small steps between levels.
8. Follow the grid strictly — you are using the whole screen.
9. Put the user's most important object in the main region.
10. Keep row data minimal, and design the empty state.
11. Selection reveals contextual actions; do not show them before.
12. Charts need grid lines, axis numbers, a summary figure and a range selector.
13. Never invent an abstract chart shape.
14. Popover = simple, non-blocking. Modal = complex but related, blocking. New page =
    permanent or very large, and it needs a back button or breadcrumb.
15. Confirm every blocking action with a toast, including the failure arm.
16. Every page is lists/tables, cards, user inputs, or tabs.
17. A good list = separation. A good table = search, filter, sort.
18. Cards get one of border or background, not both, and generous margins.
19. Tabs add pages without adding sidebar entries.
20. Keep motion tame everywhere except charts.
21. Use optimistic UI for anything the user triggers.

### Memorability — from Source B

22. Put the **interpretation next to the data**, not below it and not on another page.
    State the conclusion as a sentence before showing the number.
23. Package results as **shareable artifacts**, not tables, wherever a result is an
    achievement.
24. Give the dashboard **one distinctive form** if the data supports one — a map, a globe,
    a heat map, an orbit. Sameness is the default failure.
25. **Clean is also a differentiator.** In a busy category, restraint is the mold-breaker.
26. **Design the empty state as content**, not as an absence.
27. The dashboard must answer three things in one screenshot: **what this product does,
    how you're doing, what to do next.**
28. **Coin one metric** and name it. A named metric the user repeats aloud is a switching
    cost no competitor can copy.
29. Add **one in-place prompt under the chart** before you add a whole AI panel. The
    cheapest version of answering "why" is one line, in context.
30. Apply the screenshot test to the finished screen: **would anyone screenshot this, and
    why?**
31. If the answer to 30 is no, the fix is usually **removing** something, not adding one
    more chart.

## 16. Review checklist

Use this as a pass over any dashboard screen. Group A is correctness. Group B is whether
anyone will remember it. Failing group A is a bug. Failing group B is a bland product.

> **RepWorth status, 2026-08-28.** This section — and only this section — is scored
> against the RepWorth Console. Everything else in this file stays what the header says
> it is: a source note about two external videos, with no RepWorth token, route, or
> component in it. The boxes below are the exception, because a checklist nobody scores
> is decoration.
>
> Scored against `main` at `926d9b74`, after PRs **#987** (Harbor redesign), **#988**
> (surface polish), **#989** (shell) and **#990** (glance dashboard). A box is ticked
> only when the whole claim holds; a partial is left unticked with the gap named, so the
> list stays a to-do rather than a trophy. The decisions themselves live in
> `docs/design/console/DESIGN.md` and `.claude/reference/arch-review-log.md`.

### A — Structure

**Sidebar**
- [x] Profile/account control at the top, with a clickable affordance. — `AccountMenu` (#989)
- [x] Every link has an icon and a short label.
- [x] Links are grouped; Settings and Help are docked at the bottom. — `.nav-section--utility` (#989)
- [x] The current link has a visible active state.
- [ ] The sidebar still reads when collapsed to icons. — **no collapsed mode exists.** The
      rail is a fixed 240px and simply hides below 768px.

**Layout**
- [x] Type scale is small, with small steps between levels. — 24→18→16→14→12 (#987)
- [x] The grid is followed with no drift.
- [ ] The main region holds the user's most important object. — **deliberately not the
      reviews.** The owner chose a weekly recap over a review list, because Reviews has a
      dedicated page (#990). This is a known, chosen deviation from Source A rule 9, not
      an oversight.
- [ ] The page top bar holds page actions or simple navigation, nothing else. — it also
      carries the live-sync countdown, and on mobile the location picker and the account
      menu. The mobile pair is load-bearing: without it sign-out is unreachable.

**Data**
- [x] Row fields are the minimum set the user needs.
- [x] An empty state exists and is designed. — every list, plus the recap's quiet states
      and the ramping Rep Pulse explainer (#990)
- [ ] Bulk actions appear only after selection. — selection exists **only** in Requests,
      and is opt-out with no select-all. The reviews queue has none.
- [ ] Tables offer search, filter and sort. — Past replies has search + filter, but they
      run over the **current page only**, and there is no sort anywhere.

**Charts**
- [x] Grid lines present.
- [ ] Axis numbers present. — `StackedVelocityChart` has y-axis numbers but **no x-axis
      labels**.
- [ ] A summary figure sits above the chart. — missing on `AggregateRankingCard`, and on
      `StackedVelocityChart` outside its `total` mode.
- [ ] A range selector is present. — only on Analytics. The glance dashboard is hard-wired
      to 30 days, and the reputation trend to 8 weeks regardless of the control.
- [x] The chart type is a standard, readable one. — no invented shapes; the Rep Pulse
      gauge is a standard radial.

**Action surfaces**
- [x] Simple, non-blocking context uses a popover. — `useMenuPopover`, two callers (#989)
- [x] Complex but related context uses a modal. — native `<dialog>`, no portals
- [x] Permanent or large context uses a page, with a back button or breadcrumb.
- [ ] Every blocking action ends in a toast. — the **system** now exists (#989) with two
      callers: settings save and sign-out failure. Most mutations still report inline.
- [x] The error and warning toast states exist, not just success. — both arms shipped
      together; error is assertive and lives twice as long (#989)

**Motion**
- [x] Non-chart motion is restrained.
- [ ] Chart hover states give value and context. — only 2 of 8 charts have a tooltip with
      a delta sentence.
- [ ] User-triggered mutations apply optimistically. — **deliberately none.** Every
      mutation is pessimistic; `ImportOfferBanner` records why an optimistic flip would be
      a lie about work that had not started.

### B — Memorability

- [x] At least one number on the screen is **interpreted**, not just displayed. —
      `computeHeroHeadline`, `repPulseNote`, `computeWeeklyRecap`
- [x] The interpretation is a sentence, and it sits beside the data it explains.
- [x] The screen states **what to do next**, not only what happened.
- [x] One element on the screen is not a generic card, table or line chart. — the Rep
      Pulse gauge, and the recap's weekly bars with the running week marked apart.
- [x] The empty state is content, not an absence. — strengthened in #990: a quiet week, a
      quiet eight weeks, and a ramping score that names what will set it.
- [x] The product owns **one named metric** the user would repeat out loud. — Rep Pulse.
- [x] There is at least one in-place prompt where a user would ask "why?". — the recap's
      "why" line, and "What moved it" answered inside the Rep Pulse card (#990).
- [ ] The screen, alone, communicates what the product does to someone who has never
      seen it. — a stranger sees scores and agent names, but never a review with the reply
      RepWorth wrote for it. This is the cost of the layout choice recorded above.
- [ ] Someone would screenshot it — and you can say why in one sentence. — **the owner's
      call, not the implementer's.** Deliberately left open.

## 17. Example bank

Every product named across both videos, and the one thing it demonstrates. Most are
findable on `mobbin.com`.

| App | Source | Demonstrates |
|---|---|---|
| Dub | A, B | The sidebar promo card; a link-analytics dashboard (Source A's model) |
| Linear | A | The sidebar promo card |
| GitHub | A, B | Row descriptions in a list; the contribution heat map |
| Vercel | A | Tables with forms inside cards |
| Notion | A | Tabs as pages; a settings modal built from lists + inputs + cards |
| Gmail | A | Optimistic UI on delete |
| Fey | B | Key Indicators panel beside the chart — interpretation, not data |
| Origin | B | Weekly recap and daily brief as story cards; conclusion-first copy; AI advisor |
| Runna | B | Run stats packaged as shareable highlight cards |
| Shopify Live View | B | Dot-matrix globe of live visitors; sustained investment 2022→2024 |
| Visitors | B | Radical cleanliness as the differentiator |
| Front | B | Heat map of busiest support hours |
| Cake Equity | B | A birthday cake inside the ownership donut |
| Mercury | B | A playable game as the paid-all-bills empty state |
| Plata Card | B | Two-tone allocation ring |
| Acorns | B | Long-horizon projection chart ("Your Acorns Potential") |
| Opal | B | Screen-time data as a swipeable, shareable Instagram story |
| Orbit | B | Subscriptions as a planet with orbiting moons |
| Duolingo | B | Streaks as a coined metric |
| Oura | B | Readiness Score as a coined metric |
| Apple Fitness | B | "Closed my rings" — a coined metric that became vocabulary |
| Withings Health Mate | B | Health Improvement Score out of 100 |
| bless | B | Spending trends as Want / Got / Didn't get / Got rid of |
| GO Club | B | Hydration as a filling bottle; a mood-reflection card |
| Nike Run Club, Runbuds, Flighty, Tolan | B | Coined-metric and distinctive-form variants |
| Linktree | B | One in-place AI prompt under a chart; a full AI insights panel |
| Midday | B | An Assistant card docked in the dashboard grid |
| Evernote, ClickUp | B | AI layers over an existing workspace |
| Claude Code | B (uncredited) | Stat tiles + streaks + contribution heat map |
