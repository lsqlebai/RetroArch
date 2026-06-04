/**
 * RetroArch Web Player
 *
 * This provides the basic JavaScript for the RetroArch web player.
 */

const defaultCore = "dosbox_pure";
const coreAssetVersion = "20260604-160000";
const authApiBase = "/api/sync/v1/auth";
var autoStart = true;
var debugParams = new URLSearchParams(window.location.search);
var syncParam = debugParams.get("sync");
var disableSaveSync = debugParams.has("nosync") || syncParam === "0" || syncParam === "false";

var BrowserFS = BrowserFS;
var afs;
var zipTOC;
var initializationCount = 0;
var Module;
var currentCore;
var currentGame;
var currentUser = null;
var reloadTimeout;
var retroArchRunning = false;
var saveSyncReady = Promise.resolve();
var authReady = Promise.resolve(null);
var authModalMode = "login";
var canvas = document.getElementById("canvas");

function setMenuItemEnabled(id, enabled) {
   var item = document.getElementById(id);
   if (!item)
      return;
   if (enabled)
   {
      item.classList.remove("disabled");
      item.setAttribute("aria-disabled", "false");
   }
   else
   {
      item.classList.add("disabled");
      item.setAttribute("aria-disabled", "true");
   }
}

function setSyncControlsEnabled(enabled) {
   ["menuSyncNow", "menuUploadSync", "menuDownloadSync", "menuSyncConflicts"].forEach(function(id) {
      setMenuItemEnabled(id, enabled);
   });
}

function authRequest(path, options) {
   options = options || {};
   options.credentials = "same-origin";
   options.headers = Object.assign({
      "Accept": "application/json",
      "Content-Type": "application/json"
   }, options.headers || {});
   return fetch(authApiBase + path, options).then(function(resp) {
      return resp.text().then(function(text) {
         var data = text ? JSON.parse(text) : {};
         if (!resp.ok)
         {
            var err = new Error(data.error || ("HTTP " + resp.status));
            err.status = resp.status;
            throw err;
         }
         return data;
      });
   });
}

function updateAuthUi() {
   var label = document.getElementById("userMenuLabel");
   var message = document.getElementById("loginMessage");
   var loggedIn = !!currentUser;
   var syncEnabled = loggedIn && !disableSaveSync;
   if (label)
      label.textContent = loggedIn ? currentUser.username : "Login";
   $(".auth-logged-in").toggle(loggedIn);
   $(".auth-logged-out").toggle(!loggedIn);
   var menuUserName = document.getElementById("menuUserName");
   if (menuUserName && loggedIn)
      menuUserName.textContent = currentUser.username;
   if (message && currentUser)
      message.textContent = "";
   setSyncControlsEnabled(syncEnabled);
   if (!loggedIn && !disableSaveSync)
   {
      var status = document.getElementById("syncStatus");
      if (status)
         status.textContent = "login required";
   }
   else if (disableSaveSync)
   {
      var disabledStatus = document.getElementById("syncStatus");
      if (disabledStatus)
         disabledStatus.textContent = "sync disabled";
   }
}

function loadCurrentUser() {
   return authRequest("/me", {method: "GET"}).then(function(data) {
      currentUser = data.user || null;
      updateAuthUi();
      return currentUser;
   }).catch(function(e) {
      currentUser = null;
      updateAuthUi();
      if (e.status !== 401)
         console.warn("WEBPLAYER: auth session check failed", e);
      return null;
   });
}

function modulePreRun(module) {
   module.ENV["LIBRARY_PATH"] = module.corePath;
}

var ModuleBase = {
   noInitialRun: true,
   retroArchSend: function(msg) {
      this.EmscriptenSendCommand(msg);
   },
   retroArchRecv: function() {
      return this.EmscriptenReceiveCommandReply();
   },
   retroArchExit: function(core, content) {
      relaunch(core, content);
   },
   onRuntimeInitialized: function() {
      appInitialized();
   },
   print: function(text) {
      console.log("stdout:", text);
   },
   printErr: function(text) {
      console.log("stderr:", text);
   },
   canvas: canvas
};

function cleanupStorage() {
   localStorage.clear();
   if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
      var req = indexedDB.deleteDatabase("RetroArch");
      req.onsuccess = function() {
         console.log("Deleted database successfully");
      };
      req.onerror = function() {
         console.error("Couldn't delete database");
      };
      req.onblocked = function() {
         console.error("Couldn't delete database due to the operation being blocked");
      };
   }

   document.getElementById("btnClean").disabled = true;
}

function idbfsInit() {
   var imfs = new BrowserFS.FileSystem.InMemory();
   if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
      afs = new BrowserFS.FileSystem.AsyncMirror(imfs,
         new BrowserFS.FileSystem.IndexedDB(function(e, fs) {
               if (e) {
                  // fallback to imfs
                  afs = new BrowserFS.FileSystem.InMemory();
                  console.error("WEBPLAYER: error: " + e + " falling back to in-memory filesystem");
                  appInitialized();
               } else {
                  // initialize afs by copying files from async storage to sync storage.
                  afs.initialize(function(e) {
                     if (e) {
                        afs = new BrowserFS.FileSystem.InMemory();
                        console.error("WEBPLAYER: error: " + e + " falling back to in-memory filesystem");
                        appInitialized();
                     } else {
                        console.log("WEBPLAYER: idbfs setup successful");
                        appInitialized();
                     }
                  });
               }
            },
            "RetroArch"));
   }
}

function zipfsInit() {
   // 256 MB max bundle size
   let buffer = new ArrayBuffer(256 * 1024 * 1024);
   let bufferView = new Uint8Array(buffer);
   let idx = 0;
   // bundle should be in five parts (this can be changed later)
   Promise.all([fetch("assets/frontend/bundle.zip.aa"),
      fetch("assets/frontend/bundle.zip.ab"),
      fetch("assets/frontend/bundle.zip.ac"),
      fetch("assets/frontend/bundle.zip.ad"),
      fetch("assets/frontend/bundle.zip.ae")
   ]).then(function(resps) {
      Promise.all(resps.map((r) => r.arrayBuffer())).then(function(buffers) {
         for (let buf of buffers) {
            if (idx + buf.byteLength > buffer.maxByteLength) {
               console.error("WEBPLAYER: error: bundle.zip is too large");
            }
            bufferView.set(new Uint8Array(buf), idx, buf.byteLength);
            idx += buf.byteLength;
         }
         BrowserFS.FileSystem.ZipFS.computeIndex(BrowserFS.BFSRequire('buffer').Buffer(new Uint8Array(buffer, 0, idx)), function(toc) {
            zipTOC = toc;
            console.log("WEBPLAYER: zipfs setup successful");
            appInitialized();
         });
      })
   });
}

function appInitialized() {
   /* Need to wait for the file system, the wasm runtime, and the zip download
      to complete before enabling the Run button. */
   initializationCount++;
   console.log("WEBPLAYER: appInitialized", {
      count: initializationCount,
      hasModule: !!Module,
      hasCallMain: !!(Module && Module.callMain)
   });
   if (initializationCount == 3) {
      setupFileSystem();
      saveSyncReady = discoverCurrentGame().then(function(game) {
         currentGame = game;
         clearWebMouseOverrides();
         return authReady.then(function() {
            return initSaveSync(game);
         });
      });
      saveSyncReady.then(preLoadingComplete).catch(function(e) {
         console.warn("WEBPLAYER: save sync init failed, continuing offline", e);
         preLoadingComplete();
      });
   }
}

function callRetroArchMain(reason) {
   var args = (Module && Module.arguments) || ModuleBase.arguments || [];
   console.log("WEBPLAYER: callMain requested", {
      reason: reason,
      hasModule: !!Module,
      hasCallMain: !!(Module && Module.callMain),
      args: args,
      corePath: ModuleBase.corePath
   });
   if (!Module || !Module.callMain) {
      console.error("WEBPLAYER: callMain skipped because module is not ready");
      return;
   }
   try {
      Module.callMain(args);
      console.log("WEBPLAYER: callMain returned", {
         reason: reason
      });
   } catch (e) {
      console.error("WEBPLAYER: callMain failed", e);
      throw e;
   }
}

function initSaveSync(game) {
   if (disableSaveSync) {
      console.log("WEBPLAYER: save sync disabled", {
         gameId: game ? game.gameId : "default"
      });
      return Promise.resolve();
   }
   if (!window.RetroArchSaveSync)
      return Promise.resolve();
   if (!currentUser)
   {
      console.log("WEBPLAYER: save sync waiting for login", {
         gameId: game ? game.gameId : "default"
      });
      setSyncControlsEnabled(false);
      var status = document.getElementById("syncStatus");
      if (status)
         status.textContent = "login required";
      return Promise.resolve();
   }
   return window.RetroArchSaveSync.init({
      Module: Module,
      userId: currentUser.userId,
      gameId: game ? game.gameId : "default",
      basePath: "/home/web_user/retroarch/userdata",
      dirs: ["saves", "states"],
      apiBase: "/api/sync/v1"
   });
}

function restartSaveSyncForUser() {
   if (!Module || !window.RetroArchSaveSync)
      return Promise.resolve();
   return discoverCurrentGame().then(function(game) {
      currentGame = game;
      return initSaveSync(game);
   }).then(function() {
      renderSyncConflicts();
   });
}

function discoverCurrentGame() {
   return fetch("/api/sync/v1/games").then(function(resp) {
      if (!resp.ok)
         throw new Error("games API returned HTTP " + resp.status);
      return resp.json();
   }).then(function(games) {
      games = Array.isArray(games) ? games : [];
      var storedGameId = localStorage.getItem("gameId");
      var game = games.find(function(item) {
         return item.gameId === storedGameId;
      }) || games[0] || null;
      if (game)
      {
         localStorage.setItem("gameId", game.gameId);
         console.log("WEBPLAYER: selected cloud game", game);
      }
      return game;
   }).catch(function(e) {
      console.warn("WEBPLAYER: failed to discover cloud games", e);
      return null;
   });
}

function preLoadingComplete() {
   $('#icnRun').removeClass('fa-spinner').removeClass('fa-spin');
   $('#icnRun').addClass('fa-play');

   if (autoStart) {
      startRetroArch();
   } else {
      // Make the Preview image clickable to start RetroArch.
      $('.webplayer-preview').addClass('loaded').click(function() {
         startRetroArch();
      });
      $('#btnRun').removeClass('disabled').removeAttr("disabled").click(function() {
         startRetroArch();
      });
   }
}

function mountBrowserFS() {
   console.log("WEBPLAYER: mountBrowserFS called", {
      hasModuleFS: !!(Module && Module.FS),
      hasModulePATH: !!(Module && Module.PATH),
      hasModuleErrno: !!(Module && Module.ERRNO_CODES)
   });
   var BFS = new BrowserFS.EmscriptenFS(Module.FS, Module.PATH, Module.ERRNO_CODES);
   console.log("WEBPLAYER: created EmscriptenFS", BFS);
   Module.FS.mount(BFS, {
      root: '/home'
   }, '/home');

   // create fake core files for RetroArch
   try {
      Module.FS.writeFile("/home/web_user/retroarch/cores/" + currentCore + "_libretro.core", new Uint8Array());
      for (let core of Object.keys(libretroCores)) {
         Module.FS.writeFile("/home/web_user/retroarch/cores/" + core + "_libretro.core", new Uint8Array());
      }
   } catch (e) {
      console.error("WEBPLAYER: failed to create fake core files", e);
   }
}

function upsertConfigValue(text, key, value) {
   var line = key + ' = "' + value + '"';
   var pattern = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=.*$", "m");
   if (pattern.test(text))
      return text.replace(pattern, line);
   if (text && text[text.length - 1] !== "\n")
      text += "\n";
   return text + line + "\n";
}

function clearWebMouseOverrides() {
   restoreRetroArchWebDefaultMouseOptions();
   restoreDosboxPureDefaultMouseOptions();
}

function hideCanvasCursor() {
   if (!canvas || !retroArchRunning)
      return;
   canvas.classList.add("webplayer-hide-cursor");
}

function showCanvasCursor() {
   if (!canvas)
      return;
   canvas.classList.remove("webplayer-hide-cursor");
}

function ensureDirectory(path) {
   var parts = path.split("/");
   var current = "";
   for (var i = 0; i < parts.length; i++) {
      if (!parts[i])
         continue;
      current += "/" + parts[i];
      try {
         Module.FS.mkdir(current);
      } catch (e) {}
   }
}

function restoreRetroArchWebDefaultMouseOptions() {
   var path = "/home/web_user/retroarch/userdata/retroarch.cfg";
   var text = "";
   try {
      text = Module.FS.readFile(path, {encoding: "utf8"});
   } catch (e) {}

   var next = text;
   var autoGrab = text.match(/^input_auto_mouse_grab\s*=\s*"([^"]*)"/m);
   if (autoGrab && autoGrab[1] === "true")
      next = upsertConfigValue(next, "input_auto_mouse_grab", "false");

   if (next !== text) {
      Module.FS.writeFile(path, next);
      console.log("WEBPLAYER: restored web default mouse auto grab setting");
   }
}

function restoreDosboxPureDefaultMouseOptions() {
   [
      "/home/web_user/retroarch/userdata/retroarch-core-options.cfg",
      "/home/web_user/retroarch/userdata/config/DOSBox-pure/DOSBox-pure.opt"
   ].forEach(restoreDosboxPureMouseOptionsFile);
}

function restoreDosboxPureMouseOptionsFile(path) {
   var text = "";
   try {
      text = Module.FS.readFile(path, {encoding: "utf8"});
   } catch (e) {}

   var next = text;
   var mouseInput = text.match(/^dosbox_pure_mouse_input\s*=\s*"([^"]*)"/m);
   if (mouseInput && mouseInput[1] === "direct")
      next = upsertConfigValue(next, "dosbox_pure_mouse_input", "true");

   var mouseSpeed = next.match(/^dosbox_pure_mouse_speed_factor\s*=\s*"([^"]*)"/m);
   if (!mouseSpeed || mouseSpeed[1] !== "2.0")
      next = upsertConfigValue(next, "dosbox_pure_mouse_speed_factor", "2.0");

   if (next !== text) {
      var parent = path.slice(0, path.lastIndexOf("/"));
      ensureDirectory(parent);
      Module.FS.writeFile(path, next);
      console.log("WEBPLAYER: ensured DOSBox Pure mouse options", {
         path: path,
         speed: "2.0"
      });
   }
}

function setupFileSystem() {
   // create a mountable filesystem that will server as a root mountpoint for browserfs
   var mfs = new BrowserFS.FileSystem.MountableFileSystem();

   // create a ZipFS filesystem for the bundled data
   var zipfs = new BrowserFS.FileSystem.ZipFS(zipTOC);
   // create an XmlHttpRequest filesystem for core assets
   var xfs = new BrowserFS.FileSystem.XmlHttpRequest(".index-xhr", "assets/cores/");
   var gfs;
   try {
      gfs = new BrowserFS.FileSystem.XmlHttpRequest(".index-xhr", "assets/games/");
   } catch (e) {
      gfs = null;
   }

   mfs.mount('/home/web_user/retroarch', zipfs);
   mfs.mount('/home/web_user/retroarch/cores', new BrowserFS.FileSystem.InMemory());
   mfs.mount('/home/web_user/retroarch/userdata', afs);
   mfs.mount('/home/web_user/retroarch/userdata/content/downloads', xfs);
   if (gfs) mfs.mount('/home/web_user/retroarch/userdata/content/games', gfs);
   BrowserFS.initialize(mfs);
   mountBrowserFS();

   console.log("WEBPLAYER: filesystem initialization successful");
}

function startRetroArch() {
   $('.webplayer').show();
   $('.webplayer-preview').hide();
   document.getElementById("btnRun").disabled = true;
   console.log("WEBPLAYER: starting RetroArch", {
      args: (Module && Module.arguments) || ModuleBase.arguments,
      hasCallMain: !!(Module && Module.callMain),
      corePath: ModuleBase.corePath
   });

   $('#btnAdd').removeClass("disabled").removeAttr("disabled").click(function() {
      $('#btnRom').click();
   });
   $('#btnRom').removeAttr("disabled").change(function(e) {
      selectFiles(e.target.files);
   });
   $('#btnMenu').removeClass("disabled").removeAttr("disabled").click(function() {
      Module.retroArchSend("MENU_TOGGLE");
      Module.canvas.focus();
   });
   $('#btnFullscreen').removeClass("disabled").removeAttr("disabled").click(function() {
      Module.retroArchSend("FULLSCREEN_TOGGLE");
      Module.canvas.focus();
   });

   // subsequent relaunches will start automatically
   ModuleBase.onRuntimeInitialized = function() {
      setTimeout(function() {
         mountBrowserFS();
         callRetroArchMain("runtime-relaunch");
      }, 0);
   };

   retroArchRunning = true;
   callRetroArchMain("start");
}

function selectFiles(files) {
   $('#btnAdd').addClass('disabled');
   $('#icnAdd').removeClass('fa-plus');
   $('#icnAdd').addClass('fa-spinner spinning');
   var count = files.length;

   for (var i = 0; i < count; i++) {
      filereader = new FileReader();
      filereader.file_name = files[i].name;
      filereader.readAsArrayBuffer(files[i]);
      filereader.onload = function() {
         uploadData(this.result, this.file_name)
      };
      filereader.onloadend = function(evt) {
         console.log("WEBPLAYER: file: " + this.file_name + " upload complete");
         if (evt.target.readyState == FileReader.DONE) {
            $('#btnAdd').removeClass('disabled');
            $('#icnAdd').removeClass('fa-spinner spinning');
            $('#icnAdd').addClass('fa-plus');
         }
      }
   }
}

function uploadData(data, name) {
   var dataView = new Uint8Array(data);
   Module.FS.createDataFile('/', name, dataView, true, false);

   var data = Module.FS.readFile(name, {
      encoding: 'binary'
   });
   Module.FS.writeFile('/home/web_user/retroarch/userdata/content/' + name, data, {
      encoding: 'binary'
   });
   Module.FS.unlink(name);
}

function openAuthModal(mode) {
   authModalMode = mode === "register" ? "register" : "login";
   var title = document.querySelector("#loginModal .modal-title");
   var submit = document.getElementById("btnLoginSubmit");
   var register = document.getElementById("btnRegister");
   var message = document.getElementById("loginMessage");
   var password = document.getElementById("loginPassword");
   var confirm = document.getElementById("loginPasswordConfirm");
   if (title)
      title.textContent = authModalMode === "register" ? "Cloud Register" : "Cloud Login";
   if (submit)
      submit.style.display = authModalMode === "register" ? "none" : "";
   if (register)
      register.style.display = authModalMode === "register" ? "" : "";
   $(".auth-register-only").toggle(authModalMode === "register");
   if (password)
      password.setAttribute("autocomplete", authModalMode === "register" ? "new-password" : "current-password");
   if (confirm)
   {
      confirm.required = authModalMode === "register";
      confirm.value = "";
   }
   if (message)
      message.textContent = "";
   $('#loginModal').modal('show');
}

function submitAuth(mode) {
   var username = document.getElementById("loginUsername").value;
   var password = document.getElementById("loginPassword").value;
   var confirm = document.getElementById("loginPasswordConfirm").value;
   var message = document.getElementById("loginMessage");
   if (message)
      message.textContent = "";
   if (mode === "register" && password !== confirm)
   {
      if (message)
         message.textContent = "passwords do not match";
      return Promise.resolve();
   }
   return authRequest(mode === "register" ? "/register" : "/login", {
      method: "POST",
      body: JSON.stringify({username: username, password: password})
   }).then(function(data) {
      currentUser = data.user || null;
      updateAuthUi();
      $('#loginModal').modal('hide');
      return restartSaveSyncForUser();
   }).catch(function(e) {
      if (message)
         message.textContent = e.message || String(e);
   });
}

function setupAuthUi() {
   updateAuthUi();
   $(".auth-register-only").hide();
   authReady = loadCurrentUser();

   $('#menuLogin').click(function(e) {
      e.preventDefault();
      openAuthModal("login");
   });

   $('#menuRegister').click(function(e) {
      e.preventDefault();
      openAuthModal("register");
   });

   $('#loginForm').submit(function(e) {
      e.preventDefault();
      submitAuth(authModalMode);
   });

   $('#btnRegister').click(function() {
      submitAuth("register");
   });

   $('#menuLogout').click(function(e) {
      e.preventDefault();
      authRequest("/logout", {method: "POST"}).catch(function(e) {
         console.warn("WEBPLAYER: logout failed", e);
      }).then(function() {
         currentUser = null;
         updateAuthUi();
         renderSyncConflicts();
      });
   });
}

// When the browser has loaded everything.
$(function() {
   setupAuthUi();

   // create core list
   var coreArray = Object.entries(libretroCores);
   var coreNames = Object.values(libretroCores).sort();
   var coreSelector = document.getElementById("core-selector");
   for (let name of coreNames) {
      let a = document.createElement("a");
      a.href = ".";
      a.dataset.core = coreArray.find(i => i[1] == name)[0];
      a.textContent = name;
      a.classList.add("dropdown-item");
      coreSelector.appendChild(a);
   }

   // Enable data clear
   $('#btnClean').click(function() {
      cleanupStorage();
   });

   // Enable all available ToolTips.
   $('.tooltip-enable').tooltip({
      placement: 'right'
   });

   $('#menuSyncNow').click(function(e) {
      e.preventDefault();
      if (!currentUser || disableSaveSync || !window.RetroArchSaveSync)
      {
         var syncStatus = document.getElementById("syncStatus");
         if (syncStatus)
            syncStatus.textContent = "sync unavailable";
         return;
      }
      window.RetroArchSaveSync.setStatus("sync requested", currentGame ? currentGame.gameId : "current game");
      $('#icnMenuSync').addClass('fa-spin');
      window.RetroArchSaveSync.syncNow().catch(function(e) {
         console.warn("WEBPLAYER: manual save sync failed", e);
      }).then(function() {
         $('#icnMenuSync').removeClass('fa-spin');
         renderSyncConflicts();
      });
   });

   $('#menuUploadSync').click(function(e) {
      e.preventDefault();
      if (!currentUser || disableSaveSync || !window.RetroArchSaveSync)
      {
         var uploadStatus = document.getElementById("syncStatus");
         if (uploadStatus)
            uploadStatus.textContent = "upload unavailable";
         return;
      }
      window.RetroArchSaveSync.setStatus("upload requested", currentGame ? currentGame.gameId : "current game");
      $('#icnMenuUploadSync').addClass('fa-spin');
      window.RetroArchSaveSync.uploadNow().catch(function(e) {
         console.warn("WEBPLAYER: manual save upload failed", e);
      }).then(function() {
         $('#icnMenuUploadSync').removeClass('fa-spin');
         renderSyncConflicts();
      });
   });

   $('#menuDownloadSync').click(function(e) {
      e.preventDefault();
      console.log("WEBPLAYER: Use Cloud clicked", {
         hasSaveSync: !!window.RetroArchSaveSync
      });
      if (!currentUser || disableSaveSync || !window.RetroArchSaveSync)
      {
         console.warn("WEBPLAYER: Use Cloud ignored because save sync is not available");
         var downloadStatus = document.getElementById("syncStatus");
         if (downloadStatus)
            downloadStatus.textContent = "download unavailable";
         return;
      }
      if (!confirm("Replace local saves and states with cloud data for this game?"))
      {
         console.log("WEBPLAYER: Use Cloud canceled by user");
         return;
      }
      window.RetroArchSaveSync.setStatus("download requested", currentGame ? currentGame.gameId : "current game");
      $('#icnMenuDownloadSync').addClass('fa-spin');
      window.RetroArchSaveSync.downloadNow().catch(function(e) {
         console.warn("WEBPLAYER: manual cloud restore failed", e);
      }).then(function() {
         $('#icnMenuDownloadSync').removeClass('fa-spin');
         renderSyncConflicts();
      });
   });

   $('#menuSyncConflicts').click(function(e) {
      e.preventDefault();
      if (!currentUser || disableSaveSync)
         return;
      $('#syncModal').modal('show');
   });

   $('#syncModal').on('show.bs.modal', function() {
      renderSyncConflicts();
   });

   $('#syncConflictList').on('click', 'button[data-conflict-id]', function() {
      var button = this;
      var id = button.getAttribute('data-conflict-id');
      var action = button.getAttribute('data-action');
      button.disabled = true;
      window.RetroArchSaveSync.resolveConflict(id, action).catch(function(e) {
         console.warn("WEBPLAYER: failed to resolve sync conflict", e);
      }).then(function() {
         renderSyncConflicts();
      });
   });

   canvas.addEventListener('mousedown', hideCanvasCursor);
   canvas.addEventListener('mouseleave', showCanvasCursor);

   // Allow hiding the top menu.
   $('.showMenu').hide();
   $('#btnHideMenu, .showMenu').click(function() {
      $('nav').slideToggle('slow');
      $('.showMenu').toggle('slow');
   });

   // Attempt to disable some default browser keys.
   var keys = {
      9: "tab",
      13: "enter",
      16: "shift",
      18: "alt",
      27: "esc",
      33: "rePag",
      34: "avPag",
      35: "end",
      36: "home",
      37: "left",
      38: "up",
      39: "right",
      40: "down",
      112: "F1",
      113: "F2",
      114: "F3",
      115: "F4",
      116: "F5",
      117: "F6",
      118: "F7",
      119: "F8",
      120: "F9",
      121: "F10",
      122: "F11",
      123: "F12"
   };
   window.addEventListener('keydown', function(e) {
      if (e.which === 27)
         showCanvasCursor();
      if (keys[e.which]) {
         e.preventDefault();
      }
   });

   // Switch the core when selecting one.
   $('#core-selector a').click(function(e) {
      e.preventDefault();
      var core = $(this).data('core');
      if (!core) return;
      localStorage.setItem("core", core);
      if (Module && retroArchRunning) {
         Module.retroArchSend("LOAD_CORE /home/web_user/retroarch/cores/" + core + "_libretro.core");

         // maybe RetroArch crashed? reload if RetroArch doesn't exit within a second.
         if (reloadTimeout) clearTimeout(reloadTimeout);
         reloadTimeout = setTimeout(function() {
            location.reload();
         }, 1000);
      } else {
         location.reload();
      }
   });

   // Find which core to load.
   currentCore = localStorage.getItem("core") || defaultCore;
   loadCore(currentCore);

   // Start loading the filesystem
   idbfsInit();
   zipfsInit();
});

function conflictSideText(label, side) {
   if (!side)
      return label + ": missing";
   return label + ": " +
      (side.hash == null ? "deleted" : "present") +
      ", hash=" + (side.hash ? side.hash.slice(0, 12) : "-");
}

function renderSyncConflicts() {
   if (!window.RetroArchSaveSync)
      return;
   var conflicts = window.RetroArchSaveSync.getPendingConflicts();
   var list = document.getElementById("syncConflictList");
   var count = document.getElementById("syncConflicts");
   var menuCount = document.getElementById("menuConflictCount");
   if (count)
      count.textContent = String(conflicts.length);
   if (menuCount)
      menuCount.textContent = String(conflicts.length);
   if (!list)
      return;
   list.innerHTML = "";
   if (!conflicts.length) {
      var empty = document.createElement("p");
      empty.textContent = "No pending conflicts.";
      list.appendChild(empty);
      return;
   }
   conflicts.forEach(function(conflict) {
      var card = document.createElement("div");
      card.className = "card";
      card.style.marginBottom = "12px";

      var body = document.createElement("div");
      body.className = "card-block";

      var title = document.createElement("h4");
      title.className = "card-title";
      title.textContent = conflict.path;
      body.appendChild(title);

      var reason = document.createElement("p");
      reason.textContent = "Reason: " + conflict.reason;
      body.appendChild(reason);

      var local = document.createElement("p");
      local.textContent = conflictSideText("Local", conflict.local);
      body.appendChild(local);

      var remote = document.createElement("p");
      remote.textContent = conflictSideText("Remote", conflict.remote);
      body.appendChild(remote);

      [
         ["use_local", "Use Local"],
         ["use_remote", "Use Remote"],
         ["keep_both", "Keep Both"]
      ].forEach(function(item) {
         var button = document.createElement("button");
         button.className = "btn btn-primary";
         button.setAttribute("data-conflict-id", conflict.id);
         button.setAttribute("data-action", item[0]);
         button.textContent = item[1];
         body.appendChild(button);
      });

      card.appendChild(body);
      list.appendChild(card);
   });
}

function loadCoreFallback(currentCore) {
   if (currentCore == defaultCore) {
      alert("Error: could not load default core!");
      return;
   }
   loadCore(defaultCore);
}

function loadCore(core, args) {
   // Make the core the selected core in the UI.
   $('#core-selector a.active').removeClass('active');
   var coreTitle = $('#core-selector a[data-core="' + core + '"]').addClass('active').text();
   $('#dropdownMenu1').text(coreTitle);

   var wasmUrl = "./" + core + "_libretro.wasm?v=" + coreAssetVersion;
   ModuleBase.arguments = args || ["-v", "--menu", "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"];
   ModuleBase.preRun = [modulePreRun];
   ModuleBase.canvas = canvas;
   ModuleBase.corePath = "/home/web_user/retroarch/cores/" + core + "_libretro.core";
   ModuleBase.locateFile = function(path, prefix) {
      if (path === core + "_libretro.wasm")
         return wasmUrl;
      return (prefix || "") + path;
   };

   // Load the Core's related JavaScript.
   console.log("WEBPLAYER: loading core", {
      core: core,
      js: "./" + core + "_libretro.js?v=" + coreAssetVersion,
      wasm: wasmUrl,
      args: ModuleBase.arguments,
      corePath: ModuleBase.corePath
   });
   import("./" + core + "_libretro.js?v=" + coreAssetVersion).then(script => {
      var module = Object.assign({}, ModuleBase);
      Module = module;
      script.default(module).then(mod => {
         Module = mod;
      }).catch(err => {
         console.error("Couldn't instantiate module", err);
         loadCoreFallback(core);
         throw err;
      });
   }).catch(err => {
      console.error("Couldn't load script", err);
      loadCoreFallback(core);
      throw err;
   });
}

// exit/exitspawn hook
function relaunch(core, content) {
   // force restart on exit
   if (!core) core = ModuleBase.corePath;

   if (!content) content = "--menu";
   console.log("WEBPLAYER: relaunch requested", {
      core: core,
      content: content,
      currentModuleBaseCorePath: ModuleBase.corePath
   });

   Module = null;
   if (reloadTimeout) {
      clearTimeout(reloadTimeout);
      reloadTimeout = null;
   }

   // parse core name from full path ("/home/web_user/retroarch/cores/NAME_libretro.core")
   currentCore = core.slice(0, -14).split("/").slice(-1)[0];

   localStorage.setItem("core", currentCore);
   loadCore(currentCore, ["-v", content, "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"]);
}
