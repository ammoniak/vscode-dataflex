/*
  Starts the DataFlex web framework on a definition the language server built.

  Plain JavaScript, not TypeScript, and not bundled. It runs in the browser rather than in the
  extension host, so it would need its own esbuild target, its own tsconfig with `lib: ["DOM"]`
  (the extension's has none) and its own typecheck script -- a lot of build machinery around a
  hundred lines that import nothing. If this ever grows a dependency, that is the moment to give
  it a build.

  The sequence below is not the framework's documented one. `df.WebApp#displayApp` begins by
  calling `initialize()`, which asks the server for the application definition and only marks the
  app ready once the reply arrives. There is no server here, so this replays what that reply's
  handler does -- work out the theme, adopt the stylesheets, mark ready -- and then feeds in the
  definition the server would have sent. Everything it touches is a plain property on `df.BaseApp`.

  After the first render the page stays put and rebuilds in place on each new definition the
  extension posts. See `render` and `teardown`.
*/
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var model = window.__dfPreview;
  /* The live app, or null between a teardown and the next render. */
  var app = null;

  function log(detail) {
    vscode.postMessage({ type: 'log', detail: String(detail) });
  }

  function fail(message) {
    var viewport = document.getElementById('viewport');
    viewport.textContent = '';
    var box = document.createElement('div');
    box.className = 'dfpreview-message';
    var title = document.createElement('h2');
    title.textContent = 'The preview could not be drawn';
    var body = document.createElement('p');
    body.textContent = message;
    box.appendChild(title);
    box.appendChild(body);
    viewport.appendChild(box);
    log(message);
  }

  /*
    df.Error is not a JavaScript Error. It keeps its text on `sText` and its code on `iNumber`, and
    holds a reference to the control that raised it -- which holds the app, which holds the control
    again. So `.message` is undefined and `JSON.stringify` throws on the cycle: read it by hand, or
    every framework failure reads "[object Object]".
  */
  function describeError(err) {
    if (!err) {
      return String(err);
    }
    if (err.sText) {
      return err.iNumber + ': ' + err.sText;
    }
    return err.message || String(err);
  }

  window.addEventListener('error', function (event) {
    log('uncaught: ' + (event.message || describeError(event.error)));
  });

  if (typeof df === 'undefined') {
    fail('The DataFlex web framework did not load. Check that AppHtml/WebUI/df-min.js is readable.');
    return;
  }

  /*
    The preview never moves the focus.

    Three separate things would. `df.WebView#_show` ends in a timeout that calls `conditionalFocus`
    on the first control. `df.WebWindow#_show` opens a dialog view by calling `showModal()` on a
    `<dialog>`, after which the browser -- not the framework -- focuses the first focusable thing
    inside it, which is the close button. And a floating panel focuses itself when it is shown. In
    a webview each of them pulls the caret out of the editor, and since the preview redraws while
    the file is being typed in, each of them does it again every few keystrokes.
    `pbFocusFirstOnShow`, the framework's own switch, covers only the first.

    So the DOM call is neutered for everything inside the drawing. The framework's own bookkeeping
    -- `objFocus`, which remembers which object has the focus -- runs exactly as before; the
    browser is simply never told. Everything outside the viewport still focuses normally, which is
    what leaves the webview host's own handling of the panel alone. A `<dialog>` needs the second
    patch because its focusing is a step the browser takes on its own rather than a call to
    `focus()`: marking it inert for the length of the call leaves nothing in it to focus, and it
    still opens, still lands in the top layer and still matches `:modal`.
  */
  [
    [window.HTMLElement, 'focus'],
    // `df.WebForm#focus` selects the text after focusing, and selecting an input focuses it: the
    // one call the framework makes on a form, `conditionalFocus(true)`, comes through both.
    [window.HTMLInputElement, 'select'],
    [window.HTMLTextAreaElement, 'select']
  ].forEach(function (aPatch) {
    var oType = aPatch[0];
    var sName = aPatch[1];
    if (!oType) {
      return;
    }
    var fNative = oType.prototype[sName];
    oType.prototype[sName] = function () {
      var eViewport = document.getElementById('viewport');
      if (eViewport && eViewport.contains(this)) {
        return;
      }
      return fNative.apply(this, arguments);
    };
  });
  if (window.HTMLDialogElement) {
    ['show', 'showModal'].forEach(function (sName) {
      var fNative = HTMLDialogElement.prototype[sName];
      HTMLDialogElement.prototype[sName] = function () {
        var bWas = this.inert;
        this.inert = true;
        try {
          return fNative.call(this);
        } finally {
          this.inert = bWas;
        }
      };
    });
  }

  /* How long the picture report waits for the last image before reporting what it has. */
  var IMAGE_WAIT_MS = 5000;

  /*
    Builds the app and draws the view.

    Everything that is per-definition lives here, because a re-render replaces the app rather than
    updating it: `initJSON` builds a tree, it does not reconcile one, so there is no update path
    short of a new app. `updateCSS` is called again for each one and does not duplicate anything --
    it adopts the `<link>` elements already in the document when it finds them.
  */
  function render(tModel, bFirst) {
    model = tModel;
    // For `scripts/preview-check.ts`, which loads this file into a headless browser and wants to
    // ask the app what it built. Nothing in the extension reads them.
    window.__dfPreview = model;

    app = new df.WebApp('');
    window.__dfPreviewApp = app;

    /*
      A server call has nowhere to go.

      Intercepted at processCall rather than sendCall: sendCall's rejection goes to handleError,
      which reports a failed round trip -- and, until the override below, drew a modal error box
      over the preview to do it. This stops the call before it starts, unlocks the display and
      says what was attempted, so a button that would have called the server says so instead of
      appearing to hang.
    */
    app.processCall = function () {
      this._oPendingCall = null;
      try {
        this.unlock();
      } catch (err) {
        /* unlock throws when nothing was locked, which is the normal case here. */
      }
      log('a control tried to call the server; the preview has none');
    };

    /*
      A framework error is reported, not put on the screen.

      `df.BaseApp#handleError` opens a modal error box, which is a view of its own: it covers the
      drawing, it has to be dismissed, and on a redraw it comes back. What it says is worth having
      -- these are real complaints about what the definition asked for, and `DemoCustomMenu.wo`
      raises one -- so it goes to the output channel, where the rest of the preview's account of
      itself already goes.
    */
    app.handleError = function (oError) {
      log('the framework reported: ' + describeError(oError));
    };

    // Stops displayApp/ready from calling initialize(), which is the LoadWebApp round trip.
    app._bInitStarted = true;

    try {
      app.determineSystemThemePreference();
      app.updateCSS(false);
    } catch (err) {
      log('theme setup: ' + err);
    }

    if (!bFirst) {
      draw();
      return;
    }
    // Only the first render waits: testCSS asks the browser whether the framework's stylesheets
    // have taken effect, and by the time a second definition arrives they long since have.
    app.testCSS(function () {
      draw();
      // Said once the page can be talked to. Until this arrives the extension rewrites the whole
      // page for a new definition, because a message posted to a webview that has not run its
      // script yet is dropped rather than queued.
      vscode.postMessage({ type: 'ready' });
    });
  }

  /* Builds the object tree and shows the view. The half of a render that repeats. */
  function draw() {
    try {
      app.initJSON(model.definition);
      app._bReady = true;

      var view = app[model.view];
      if (!view) {
        fail('The definition built no object named ' + model.view + '.');
        return;
      }

      var viewport = document.getElementById('viewport');
      app._eViewPort = viewport;

      view._show(viewport);
      reportImages(viewport, Date.now() + IMAGE_WAIT_MS);
    } catch (err) {
      fail(describeError(err));
    }
  }

  /*
    Takes the current app apart, so the next one starts on an empty page.

    The view is destroyed before the app, and by hand: `BaseApp#addChild` keeps views in `_aViews`
    rather than `_aChildren`, so `app.destroy()` -- which walks `_aChildren` -- would leave the
    whole rendered tree behind, and `WebObject#destroy` unregisters from `app._oModeControl`, which
    `BaseApp#destroy` nulls on its way out. Destroying it this way removes each control's DOM
    element and its event handlers, which a bare `innerHTML = ""` would leak.
  */
  function teardown() {
    if (!app) {
      return;
    }
    var view = model && app[model.view];
    if (view) {
      destroyMenus(view);
    }
    destroyMenus(app);
    // Separately, because a throw out of one of them must not cost the other: what is left half
    // destroyed is unreachable once the app reference goes, but a control that registered a
    // listener on the document outlives the tree it belonged to.
    attempt(function () {
      if (view && view.destroy) {
        view.destroy();
      }
    });
    attempt(function () {
      app.destroy();
    });
    app = null;
    var viewport = document.getElementById('viewport');
    if (viewport) {
      viewport.textContent = '';
    }
  }

  function attempt(fStep) {
    try {
      fStep();
    } catch (err) {
      log('teardown: ' + describeError(err));
    }
  }

  /*
    Context menus come out first, each with something to unbind from.

    `WebContextMenu#destroy` unbinds from the control the menu is attached to, and unbinding reads
    that control's element -- twice over a problem here. Nothing orders the two, since
    `WebObject#destroy` pops `_aChildren` from the end, so the control is as likely as not to have
    been destroyed already; and a menu with an empty `psControlName` is attached to the app, which
    in the preview never has an element at all, because only `displayApp` renders one and the
    preview does not call it. Either way the framework throws `df.Error 999` from the middle of the
    teardown, and what it leaves behind is the menu's own listeners on the document -- one more set
    on every redraw.

    So the menus are destroyed while the rest of the tree is still standing, and anything missing
    an element is lent a detached one for the length of that call. Lent rather than given: an app
    that has an element is an app the framework believes is rendered, and it goes looking for the
    main area and the panels that a rendered app has.

    Each menu is taken out of its parent's child list as well, since `WebObject#destroy` does not
    do that, and being destroyed twice walks into the same throw. `unbind` is the framework's own
    marker for a control attached to another one; `WebContextMenu` is the only class that has it.
  */
  function destroyMenus(oObj) {
    var aChildren = (oObj._aChildren || []).slice();
    for (var i = 0; i < aChildren.length; i++) {
      destroyMenus(aChildren[i]);
    }
    if (typeof oObj.unbind !== 'function') {
      return;
    }
    var oParent = oObj._oParent;
    var oRoot = oObj._oRootControl;
    var bLent = oRoot && !oRoot._eElem;
    if (bLent) {
      oRoot._eElem = document.createElement('div');
    }
    attempt(function () {
      oObj.destroy();
    });
    if (bLent) {
      oRoot._eElem = null;
    }
    var at = oParent && oParent._aChildren ? oParent._aChildren.indexOf(oObj) : -1;
    if (at >= 0) {
      oParent._aChildren.splice(at, 1);
    }
  }

  /*
    A new definition for the same file, sent because the source changed.

    Rebuilding in place rather than reloading the page is what makes the preview usable while
    typing: rewriting `webview.html` re-fetches and re-parses 600 KB of framework and repaints the
    panel from blank, which reads as a flicker on every few keystrokes. This swaps the object tree
    under the same document, and the stylesheets, the theme and the framework stay where they are.
  */
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'model') {
      return;
    }
    /*
      The drawing area follows the mode the definition was built for. `data.width` is absent for
      the base layout, which is drawn at whatever the panel happens to be -- the same thing an
      empty `style` attribute means in the page the extension writes.
    */
    var area = document.getElementById('viewport');
    if (data.width) {
      area.style.maxWidth = data.width + 'px';
    } else {
      area.removeAttribute('style');
    }
    var problems = problemsElement(data.model.problems);
    var showing = document.getElementById('dfpreview-problems');
    if (showing) {
      showing.replaceWith(problems);
    } else {
      // The page carries no problems block when the first definition had none to report.
      document.body.insertBefore(problems, document.getElementById('viewport'));
    }
    teardown();
    render(data.model, false);
  });

  /* The problems block, rebuilt for a new definition. Mirrors `problemsHtml` in `preview.ts`. */
  function problemsElement(problems) {
    var box = document.createElement('details');
    box.id = 'dfpreview-problems';
    if (problems.length === 0) {
      box.hidden = true;
      return box;
    }
    var summary = document.createElement('summary');
    summary.textContent =
      problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' could not be drawn';
    var list = document.createElement('ul');
    for (var i = 0; i < problems.length; i++) {
      var item = document.createElement('li');
      var where = document.createElement('span');
      where.textContent = 'line ' + (problems[i].range.start.line + 1);
      item.appendChild(where);
      item.appendChild(document.createTextNode(' ' + problems[i].message));
      list.appendChild(item);
    }
    box.appendChild(summary);
    box.appendChild(list);
    return box;
  }

  df.dom.ready(function () {
    render(model, true);
  }, this);

  /*
    Says which pictures loaded and which did not, once they have all been tried.

    A picture that does not show is indistinguishable, from the editor, from one that was never
    asked for: the page cannot be inspected and the framework does not complain. So the page says
    so itself -- what `src` the framework wrote and the url the browser resolved it to, which is
    where the `<base>` and the resource policy show their hand. Polled rather than listened for,
    since the framework creates the elements after this script has run, and `load` does not
    bubble.
  */
  function reportImages(viewport, deadline) {
    var images = Array.prototype.slice.call(viewport.querySelectorAll('img'));
    var asked = images.filter(function (img) {
      return (img.getAttribute('src') || '') !== '';
    });
    var settled = asked.every(function (img) {
      return img.complete;
    });
    if (!settled && Date.now() < deadline) {
      setTimeout(function () {
        reportImages(viewport, deadline);
      }, 250);
      return;
    }
    var failed = asked.filter(function (img) {
      return !(img.complete && img.naturalWidth > 0);
    });
    vscode.postMessage({
      type: 'images',
      total: asked.length,
      loaded: asked.length - failed.length,
      failed: failed.map(function (img) {
        return { src: img.getAttribute('src'), url: img.src };
      })
    });
  }

  /*
    Marks each rendered control with the source object it came from, so a click can find its way
    back to the editor. The framework hangs the outermost element of a control on `_eElem`, which
    is what makes this a walk of the definition rather than a guess at the DOM.

    Objects are addressed by their dotted long name, `oCustomer.oMainPanel.oName`, never the bare
    name: `findObj` splits on `.` and walks `app[part][part]`, so a bare `oName` finds nothing and
    only the view -- a direct child of the app -- would ever be tagged, sending every click to the
    top of the file. The framework stamps the same long name on its own elements as `data-dfobj`,
    but only from the base `openHtml`s; tagging from the definition does not depend on which
    subclasses keep that.

    Run on every click rather than once after the render. A card container renders a tab page's
    children only when that page is first shown, so a page that was not current when the view
    was drawn has no elements to tag until the user switches to it. One findObj per object, and
    the same attribute value each time, so it is cheap and idempotent.

    A tab page's button lives in the container's header, outside the page's own element, and is
    tagged with the page: clicking the tab reveals the page.
  */
  function tagObjects(app, node, parentPath) {
    var path = node.sName === '' ? '' : parentPath === '' ? node.sName : parentPath + '.' + node.sName;
    if (path !== '') {
      var object = app.findObj(path);
      if (object) {
        if (object._eElem) {
          object._eElem.setAttribute('data-df-object', path);
        }
        if (object._eBtn) {
          object._eBtn.setAttribute('data-df-object', path);
        }
      }
    }
    for (var i = 0; i < node.aObjs.length; i++) {
      tagObjects(app, node.aObjs[i], path);
    }
  }

  /*
    The object a click landed on, as its dotted long name, or null outside any control.

    A grid column has no element of its own. The list draws it as a header cell and one body cell
    per row, each carrying `data-dfcol` with the column's position in the list's `_aColumns`. So
    a click that passed through such a cell on its way up to the list belongs to the column, which
    is what clicking a column header means.
  */
  function objectAt(element) {
    if (!app) {
      return null;
    }
    tagObjects(app, model.definition.obj, '');
    var column = -1;
    while (element && element !== document.body) {
      if (element.getAttribute) {
        if (column < 0 && element.hasAttribute('data-dfcol')) {
          column = parseInt(element.getAttribute('data-dfcol'), 10);
        }
        var path = element.getAttribute('data-df-object');
        if (path) {
          var owner = column >= 0 ? app.findObj(path) : null;
          var col = owner && owner._aColumns && owner._aColumns[column];
          return col && col.getLongName ? col.getLongName() : path;
        }
      }
      element = element.parentNode;
    }
    return null;
  }

  /*
    The responsive-mode picker.

    Only the choice is sent; the extension asks the language server for a definition built for that
    mode and posts it back. Deciding here is not an option -- `WebSetResponsive` values never reach
    the browser in the definition at all, so there is nothing in this page to switch between.

    The select lives in the banner, which the extension writes with the current mode already
    selected, so a page rebuilt for another reason comes back on the same layout.
  */
  (function () {
    var picker = document.querySelector('#dfpreview-mode select');
    if (!picker) {
      return;
    }
    picker.addEventListener('change', function () {
      vscode.postMessage({ type: 'mode', mode: picker.value });
    });
  })();

  /*
    Click to reveal. Capturing, because controls stop their own clicks -- a tab header swallows one
    to switch pages -- and a bubbling listener would never hear about the interesting ones.
  */
  document.addEventListener(
    'click',
    function (event) {
      var path = objectAt(event.target);
      if (path) {
        vscode.postMessage({ type: 'reveal', path: path });
      }
    },
    true
  );
})();
