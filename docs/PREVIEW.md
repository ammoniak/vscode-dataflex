# Previewing web views

Written 2026-08-31. Everything below is implemented and verified against DataFlex 26.0.87.118 and
the Web UI package 1.0.52.

Open a `.wo` and run **DataFlex: Preview Web View**, or press the preview button in the editor
title bar. The view is drawn beside the source, in the workspace's own theme, and follows you as
you type. No build, no server, no DataFlex process.

It is drawn by the DataFlex web framework itself — the same `df.WebForm`, `df.WebTabContainer` and
`df.WebList` objects the running application uses, laid out by the same code. It is not an
imitation.

## How it works

### What the Studio does, and why this does not copy it

`Lib\WebAppDesigner.html` is an empty shell: a `<base>` tag and a `<div id="previewer">`. The
Studio loads it into a WebView2 under a virtual host `https://locallib.asset/`, injects
`WebUI/system.css` and `WebUI/df-min.js`, and then runs one of two bootstraps, both of which are
strings inside `Studio.exe`:

```js
oWebApp = new df.LocalApp(false); oWebApp.displayApp("#viewport");
oPreviewer = new df.Designer("viewport"); oPreviewer.pbStandalone = ...
```

Neither is available to us. `df.LocalApp` throws unless `window.chrome.webview` exists — it is a
request/response client with the Studio as its server. `df.Designer` is not in the shipped
framework at all; the only trace of it there is a `df.Designer ? ... : ...` feature check in
`WebFloatingPanel`. It is compiled into `Studio.exe`.

### The route that is available

`df-min.js` ships with a source map that carries `sourcesContent` — the framework's own 127 modules,
readable. `df/BaseApp.js` has `initJSON(tDef)`, which builds an entire live control tree from plain
JSON:

```
tDef = { aClasses: [ { hClassId, sType: "df.WebButton", props: {…}, advProps: {…} } ],
         obj:      { sName, hClassId, props: {}, advProps: {}, aObjs: [ …children ] } }
```

For each node it resolves a constructor with `df.sys.ref.getNestedProp(tClass.sType)`, does
`new FConstructor(tObj.sName, oContext)`, applies `Object.assign({}, tClass.props, tObj.props)`
through `oObj._set(…)`, calls `oParent.addChild(oObj)`, recurses `aObjs`, then `oObj.create(tObj)`.
`sType === "df.WebApp"` is special-cased to mean "this node is the app itself", which is why a
definition can be rooted at a synthesised app even when the file declares only a view.

That is normally the server's reply to `LoadWebApp`. It is also, exactly, something a parser can
produce. `df/WebApp.js` reaches a server in one method, `sendCall`; `displayApp` and the rendering
path are local.

So the whole thing is:

```js
const app = new df.WebApp("");
app._bInitStarted = true;          // stops displayApp calling initialize(), the LoadWebApp round trip
app.determineSystemThemePreference();
app.updateCSS(false);
df.dom.ready(() => app.testCSS(() => {
  app.initJSON(definition);        // what the server would have sent
  app._bReady = true;
  app[view]._show(viewport);       // what displayView's handler does, minus the round trip
}));
```

`packages/vscode-dataflex/media/preview/bootstrap.js` is that, plus error handling.

### Where the definition comes from

`packages/df-langserver/src/preview/` builds it, behind the `dataflex/previewModel` request. It
needs the class index, which is why it lives in the server rather than the extension.

**Which JavaScript class draws a DataFlex class** comes from `Set psJSClass to "df.WebButton"` in
the class's `Construct_Object`, recorded on `ClassRecord.jsClass` during indexing and resolved up
the inheritance chain — so an application's `Class cCustomerForm is a cWebForm`, which names no
JavaScript class of its own, is drawn by `df.WebForm` exactly as the runtime does it.

The class-level `{ DesignerJSClass=... }` tag is deliberately **not** used. It covers less (79
classes set the property, 65 carry the tag, and the only two with a tag and no property are the
abstract `cWebObject` and `cWebBaseControl`), it never disagrees where both exist, and
`cWebBaseControl`'s tag is `df.WebDesignerControl` — a class that exists only inside `Studio.exe`.
Since that class is an ancestor of every control, preferring the tag would hand out a constructor
that does not exist.

**Which property values** are the `Set` statements in the object body and in the class's own
`Construct_Object`, filtered to `{ WebProperty=Client }` properties — which is what keeps
`Set Main_File to Customer.File_Number` and `Set psJSClass to "df.WebForm"`, neither of which means
anything in a browser, off a JavaScript control.

Declared property defaults are deliberately not sent. A control class has a hundred or more, the
JavaScript class already initialises its own, and pushing ours over the top is a way to introduce
disagreements that show up only as a control drawn subtly wrong.

A `Set` written inside one of the class's *own* subobjects is that object's, not the class's. The
test is the nearest enclosing class **or object**, which is also what finds the subobjects below.

**Which child objects** are the ones the object body declares, and, before them, the ones its class
declares. A class's `Construct_Object` creates subobjects in every instance of it, so a widget whose
whole content is written in `Composite cDashboardTileWidget is a cWebWidget` has that content in the
view that instantiates it — the object body is empty and the drawing is not. Both spellings are
found: `Composite … End_Composite` writes them straight in the body, `Class … / Procedure
Construct_Object / Object …` nests them under the procedure. Class first and base-first, which is
the order the constructors run in, and the order a container lays its children out in.

Two guards, neither of which a real workspace should reach. A class currently being expanded is not
expanded again inside itself, so `Class cPanel … Object oInner is a cPanel` terminates rather than
hanging the language server on source that would not run either. And a name the class already used
wins over an object body redeclaring it, because `initJSON` would otherwise overwrite
`oParent[sName]` and lose the first one and everything under it.

**Values** are resolved by `preview/values.ts`, and this is where the work is. Constants come from
the workspace package's `constantValues.ts`, which reads a `Define`'s value and an `Enum_List`
member's position off the symbol index -- the same evaluator the hover uses to show a constant's
value, so the two cannot disagree:

| Source | Sent |
| --- | --- |
| `"Customer Maintenance"` | `Customer Maintenance` |
| `10`, `-1` | `10`, `-1` |
| `True` / `False` | `true` / `false` |
| `alignRight` | `2` |
| `C_WebDefault` | `-1` |
| `C_Icon_ShowHistory`, a `Define` for a string, a number, a boolean or another `Define` | what it is defined for — `Images/History.png` |
| anything else | nothing — the class default applies, and the panel says so |

`alignRight` is the interesting one. The DataFlex and JavaScript halves of the framework name the
same constant differently — `alignRight` against `df.ciAlignRight` — and agree only on the number,
so the name cannot be forwarded. The number is the position of a bare `Define` inside an
`Enum_List`, read out of whichever package declares it, so a Web UI update cannot make it stale.

Every value is then forced to the property's declared type. DataFlex converts on assignment, so
`Set psValue to 5000` puts the *string* `"5000"` into a `String` property and nobody writing the
view thinks twice about it. The framework does not convert. Handing it the number gets as far as
rendering and then throws `e.trim is not a function` from inside the framework, and the whole view
is blank. `WebOrder`'s own `OrderListSample.wo` does exactly this.

Unresolved values are omitted, never guessed at and never sent as `null`. The failure mode is
"less faithful", never "confidently wrong".

### Dashboards and widgets

A `cWebWidgetContainer` does not hold its widgets, and a definition built from the source nesting
draws them in the wrong parent with no grid at all. What the runtime does instead:

- `RegisterChildWebObject` intercepts every child that is a `cWebWidget` and keeps it out of the
  client tree entirely, collecting it into `paDefaultWidgets`. Anything that is not a widget — the
  context menu the container makes for itself — is forwarded to the normal registration and stays
  on the container.
- `End_Construct_Object` creates a `cWebWidgetContainerInternal` (`df.WebWidgetContainerInternal`),
  and `DetermineDefaultConfig` turns the collected widgets into a `tContainerDef` — each one's
  `piRowIndex`, `piColumnIndex`, `piRowSpan`, `piColumnSpan` and `pbFillHeight`, which is exactly
  what the static declaration says.
- `LoadConfigurationEx` copies `piRowCount`, `piColumnCount`, `psDefaultRowHeight` and
  `psDefaultColumnWidth` off the wrapper onto the internal container and re-creates the widgets
  under it with `CreateDynamicObject`.

So the preview builds that shape: the container, a synthesised `oPreviewWidgetHost` under it, and
the widgets under that.

```
oWidgetContainer        df.WebWidgetContainer          flow, the wrapper
  └ oPreviewWidgetHost  df.WebWidgetContainerInternal  the grid
      ├ oGetStarted     df.WebWidget, with its class's content expanded into it
      └ oProjectTile
```

None of it needs a server. `df.WebWidget` is a plain `WebGroup`, and
`df.WebDynamicObjectContainer` is a plain `WebBaseContainer` whose children render through the
ordinary `renderChildren` path — `loadDynamicObjects` is only the route the server uses to get them
there, not a condition of their being drawn.

The four grid properties have to be copied here rather than left to the framework:
`df.WebWidgetContainer#set_piColumnCount` forwards to `this._oWidgetContainer`, and `initJSON`
applies a parent's properties before its children exist, so that forward runs against a null and is
lost. They are copied *after* the responsive rules, because on a live client the wrapper's
`propRule` reaches the internal container through that same forward — which is what makes
`WebSetResponsive piColumnCount rmTablet to 4` narrow the grid in the preview's tablet mode.

The three classes are looked up by DataFlex name, not hard-coded to their JavaScript ones, so a
workspace on another Web UI version gets whatever that version ships. A workspace with no
`cWebWidgetContainerInternal` in its index draws the widgets in the container and says so, rather
than inventing a class name.

The widget *palette* (`cWebWidgetPalette`, a `cWebList`) draws with its columns and no rows, like
every other list here: its entries are the registered widget classes, which `OnRegisterWidgets`
sends at runtime.

### Where the framework comes from

The workspace's own `AppHtml`, in place. Nothing is copied, nothing is vendored into this
repository, and nothing enters the vsix — `df-min.js` is DataFlex's.

The list of what to load is `AppHtml\Index.html`'s managed-includes block, verbatim, with its
relative urls rewritten through `asWebviewUri`. That block is what `df-cli` maintains, and it names
the framework version the project actually uses, every theme it ships, and — between the
`DataFlex Custom Controls` markers — the JavaScript for every custom control the application
defines. **That is how custom controls are previewed**; building the list here instead would draw
them as blank boxes. `findWebAssets` in `df-workspace` is the shared implementation.

The install's `Lib\StudioHTML\WebUI` is deliberately not used as a fallback. It is a different Web
UI version (1.0.47 against the workspace's 1.0.52), and previewing against a framework the project
does not use would be wrong in a way nobody would notice.

### Relative urls

The framework writes urls into the page as it finds them: `df.WebImage#updateImage` assigns
`psUrl` straight to `img.src`, `WebColumnImage` emits `<img src="psImageUrl">`. In the running
application those are relative to `AppHtml`, because that is where `Index.html` lives. The webview
document lives nowhere near it, so the page carries `<base href="<AppHtml as a webview uri>/">` —
which is exactly what the Studio's shell does with its `<base id="previewer_base">`. With it,
`Set psUrl to "Images/PoweredByDataFlex.png"` draws the picture. Everything the page emits itself is
already an absolute uri and is unaffected.

Absolute `https:` image urls are not loaded; the content security policy allows images only from
the extension and the workspace. A picture from someone else's server is left as the broken image
it would be offline.

Once the view is drawn and every picture has been tried, the page reports what happened to the
DataFlex output channel -- `[preview] images: 3/3 loaded in VwKassabuch.wo`, and for each failure
the `src` the framework wrote and the url the browser resolved it to. That pair is the diagnosis:
a wrong `src` is the view's, a wrong url is the `<base>`'s, and a right url that still fails is
the resource policy's. The report counts only pictures the framework asked for on the pages it
drew: a tab page that is not current renders nothing until it is clicked, and a grid column's
pictures need rows, which the preview has none of. The integration suite asserts on the same
report through `onDidReportPreviewImages` on the extension's API, which is how a relative url is
known to survive the `<base>`, the policy and the resource roots in a real webview -- the headless
check renders under `file:`, where a relative url needs none of them.

### Click to source

Each rendered control is tagged with its object's **dotted long name**, `oCustomer.oMainPanel.oName`,
and `PreviewModel.ranges` is keyed the same way. Not the bare name: `df.BaseApp#findObj` splits on
`.` and walks `app[part][part]`, so `findObj("oName")` finds nothing and only the view — a direct
child of the app — could ever be tagged, sending every click to the top of the file. The long name
is also what the framework itself stamps on its elements as `data-dfobj`, and it keeps two panels'
`oName` objects apart.

The tagging happens at click time, not once after the render. A card container renders a tab
page's children only when that page is first shown, so anything on a page that was not current
when the view was drawn has no elements yet — a one-time pass leaves the whole second tab
unclickable. A tab page's header button is tagged with the page, so clicking the tab reveals it.

A grid column has no element of its own: the list draws it as a header cell and a body cell per
row, each marked `data-dfcol` with the column's index into the list's `_aColumns`. A click that
passed through such a cell on its way up to the list is resolved to the column.

The source is not necessarily the previewed file. An object expanded out of a class is written
wherever that class is, so a `ranges` entry carries an optional `file` alongside the range and the
click opens that document instead — clicking the icon inside a dashboard tile lands on
`Object oModuleIcon` in `cDashboardTileWidget.wo`. `file` is absent for the previewed file itself,
which is the common case.

A widget that moved into the synthesised `oPreviewWidgetHost` is keyed by where it ended up, since
that is the long name `findObj` walks. The host itself carries the container's range, so a click on
empty grid reveals the container.

### Following the source

An edit schedules a redraw 400 ms later, so a burst of typing is one redraw rather than one per
character. What happens then is deliberately not a page reload:

- **Nothing changed, nothing happens.** The model the server builds is compared with the one on
  screen. Typing inside a method body, a comment or anything else a static read does not look at
  produces the same definition, and the preview is left alone entirely.
- **A new definition is posted to the page**, which tears the old app down and builds another one
  in the same document. Rewriting `webview.html` instead re-fetches and re-parses 600 KB of
  framework and repaints the panel from blank, which reads as a flicker every few keystrokes.
  The teardown destroys the view by hand before the app: `BaseApp#addChild` keeps views in
  `_aViews` rather than `_aChildren`, so `app.destroy()` alone would leave the whole rendered tree
  and its DOM handlers behind. The page is only rewritten when what it is built from changes --
  the framework include list, the theme -- or when it has not yet said it is listening, because a
  message posted to a webview whose script has not run is dropped rather than queued. A page that
  reloads, which is what dragging the panel to another editor group does, comes back drawing the
  definition its html carries and says so; the updates posted since are sent again.
- **The preview never moves the focus.** Three separate things in the framework would.
  `df.WebView#_show` ends in a timeout that calls `conditionalFocus` on the first control;
  `df.WebWindow#_show` opens a dialog view with `showModal()` on a `<dialog>`, after which the
  *browser* focuses the first focusable thing inside it -- the close button; and a floating panel
  focuses itself when shown. In a webview each of them pulls the caret out of the editor, and with
  a redraw every few keystrokes each of them does it again and again. `pbFocusFirstOnShow`, the
  framework's own switch, covers only the first, so the page neuters `HTMLElement.focus` for
  everything inside the drawing instead -- and `HTMLInputElement.select` with it, because
  `df.WebForm#focus` selects the text after focusing and selecting an input focuses it, which is
  how a form still took the caret with `focus` alone blocked. The framework's own bookkeeping
  (`objFocus`, which remembers which object has the focus) runs as it always did, and the browser
  is simply never told. Outside the viewport nothing is patched, which leaves the webview host's
  own handling of the panel alone. A `<dialog>` needs a third answer, because
  its focusing is a step the browser takes rather than a call to `focus()`; it is marked inert for
  the length of the `show()`/`showModal()` call, which leaves nothing in it to focus and still
  opens it, in the top layer, matching `:modal`. Eighteen of `WebOrder`'s views are dialogs.
- **A framework error is reported, not drawn over the preview.** `df.BaseApp#handleError` opens a
  modal error box, which is a view of its own: it covers the drawing, it has to be dismissed, and
  a redraw brings it back. The preview logs it to the DataFlex output channel instead -- *the
  framework reported: 999: WebContextMenu could not find a element for the RootControl*, which is
  what `DemoCustomMenu.wo` raises, since a context menu with no `psControlName` binds to the
  application object and only `displayApp` gives that an element.
- **Context menus are destroyed first.** A `df.WebContextMenu` unbinds from the control it is
  attached to when it is destroyed, and reads that control's element to do it -- which may already
  have been destroyed, since children are destroyed last-first, or may never have existed, for a
  menu attached to the application. Either way the framework throws out of the middle of the
  teardown and the menu's listeners on the document survive it, one more set per redraw. So they
  come out first, while the tree is still standing, and anything missing an element is lent a
  detached one for the length of that one call -- lent, because an app that *has* an element is an
  app the framework believes is rendered, and it then goes looking for the panels of one.
- **A hidden panel waits.** Its refresh is remembered and run when it is looked at again;
  `retainContextWhenHidden` means it still has what it was showing until then.

`scripts/preview-check.ts` checks this on every render it makes: the report says whether a posted
definition rebuilt the page, and whether anything took the focus -- once for the render and again
after the rebuild -- and a view that draws but does any of it wrong is a failure.

### Responsive modes

The banner carries a picker: the base layout, desktop, and tablet and phone in both orientations.

It is not a client-side switch, and it could not be. `WebSetResponsive` values never travel in the
object definition at all -- `cWebObject_mixin.PassPropertyRules` sends every rule to the browser as
a separate `propRule` client action, and the client applies whichever ones its own detected mode
activates. A statically built `initJSON` is the base layout by construction, so there is nothing in
the page to switch between. Choosing a mode asks the language server for a model built for it, and
the rules are replayed while it is built (`buildPreviewModel`'s `mode` option, and
`preview/modes.ts` for the names; the MCP tools take the same ones).

Two things follow from that:

- **The selection is the framework's own**, read out of `df.WebObject#enforceRule`: rules sorted by
  mode descending, the first one at or below the active mode wins. A rule written for `rmTablet` is
  therefore still in force on a phone unless a mobile rule outranks it.
- **The base layout is a layout**, not the absence of a choice. It is what the framework itself
  draws before its mode controller reports in -- `peMode` starts at -1, and `enforceRule` does
  nothing below zero -- and it is what the preview has always shown, so it stays the default.

The drawing is then given that device's width. The values are already in the definition by the time
the page loads, so the width decides nothing about the layout; what it decides is whether the
layout is shown at a width it would ever be seen at, since a phone's column spans stretched across
a wide panel are the right numbers arranged into a picture of nothing.

The choice belongs to the panel, not to the workspace, so two previews of the same view can sit
side by side on desktop and phone. It survives a redraw and a page rebuild, and is forgotten when
the panel closes.

## What it cannot do

- **No data.** Lists, grids and data-bound forms get their rows and values from the server, so they
  render with their real columns, widths and headers, and empty. The banner above the preview says
  so, because a static preview of a data-driven framework is largely a picture of absent data and
  it has to read as deliberate rather than broken.
- **Nothing is clickable.** A control that would call the server is intercepted at `processCall`
  and reported in the output channel. Intercepting at `sendCall` instead would be wrong: its
  rejection routes into `handleError`, which puts a modal framework error box over the preview.
- **Only literals.** `Set psCaption to (Trim(sTitle))`, a caption assigned in `OnLoad`, or anything
  set with `WebSet` at runtime, is invisible to a static read.
- **No `.vw`.** Windows views have no client-side counterpart; nothing in the DataFlex installation
  renders them in HTML. This is not a matter of effort.
- **The DataFlex Reports viewer.** `DR.WebReportViewer` refuses to initialise without a server to
  report its version against, and says so: *"Version number mismatch in the DataFlex Reports
  previewer. Client: 26.0.0.260. Server: ."* Two of `WebOrder`'s 64 views are affected.

## Checking it

`npm run preview-check` renders a view headlessly in Chrome or Edge and reports what came out.

```bash
npm run preview-check                                     # Order Entry's customer view
npm run preview-check -- "<workspace>" "AppSrc/X.wo"      # any other
npm run preview-check -- "<workspace>" --all              # every .wo in the workspace
npm run preview-check -- ... --keep                       # leave the page to open in a browser
```

It exists for the same reason `debug-host-check` does: the thing being tested is whether 600 KB of
somebody else's JavaScript accepts a definition this repository built, and no unit test can answer
that. A definition can be structurally perfect, pass every test in
`packages/df-langserver/test/previewModel.test.ts`, and draw nothing.

The page it renders loads the extension's own `media/preview/bootstrap.js` with a stub in place of
`acquireVsCodeApi`, so what runs is the shipped code and not a copy of it. Besides whether anything
rendered, the report says:

- `located: n/m` — how many of the definition's objects `findObj` finds by dotted long name, which
  is what click-to-source depends on and should be `m/m`;
- `reveals: n/m` — how many objects a click actually reaches. The page clicks every tab button
  (which is what makes the container render the other pages), then every framework-tagged element
  and every column header, and compares what the bootstrap posted with the model's ranges. Objects
  it could not reach are listed. Some legitimately have nothing to click: a `pbHidden` column has
  no header cell, a context menu is not open, a `cWebMenuGroup` renders into the application's
  command bar rather than the view, and a drag-drop helper is not visual at all;
- `images: n/m` — how many `<img>` elements loaded their file, which is what the `<base>` is for.

Against `C:\DataFlex 26.0 Examples\WebOrder`, with 64 views:

```
drew 56, nothing renderable 6, failed 2
```

The six are `cWebService`, `cWebHttpHandler`, `cWebResourceManager` and
`cWebSessionManagerStandard` roots — non-visual, and reported as such rather than drawn as an empty
box. The two are the report viewer above.
