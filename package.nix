# 1901, packaged: one binary with the built frontend beside it. The wrapper
# wires the two together; every env override (ADDR, DB, BASE_URL, MAX_GAMES,
# SPADIR, GENERATED_VARIANTS) still works on top.
#
# There is no placements directory any more. A variant's approved table travels
# with its art, in variants/generated/<key>/placements.json, and a server with
# no separate directory is a working server (placements.go).
{
  lib,
  stdenv,
  buildGoModule,
  nodejs_24,
  npmHooks,
  fetchNpmDeps,
  makeWrapper,
  symlinkJoin,
}:
let
  version = "0.1.0";

  # Frontend sources only: no node_modules, no build output, no test cache.
  webSrc = lib.cleanSourceWith {
    src = ./web;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      !(lib.elem name [
        "node_modules"
        "dist"
      ])
      && !lib.hasSuffix ".tsbuildinfo" name;
  };

  webDeps = fetchNpmDeps {
    src = webSrc;
    hash = "sha256-966lKCI9FHDEoOBGnZ9dxrENejLzxrSdon2iGbwbpRw=";
  };

  web = stdenv.mkDerivation {
    pname = "1901-web";
    inherit version;
    src = webSrc;

    nativeBuildInputs = [
      nodejs_24
      npmHooks.npmConfigHook
    ];
    npmDeps = webDeps;

    # SCREENS=1 builds the design gallery into the site (/dev/screens). It is
    # a lazy chunk, so a player's phone never downloads it; what the flag
    # decides is whether the chunk exists on the server at all. A release
    # build for somebody else to run omits this and carries no gallery.
    buildPhase = ''
      runHook preBuild
      VITE_SCREENS=1 npm run build
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/1901/web/dist
      cp -r dist/. $out/share/1901/web/dist/
      runHook postInstall
    '';
  };

  # Go sources only. The Go code needs nothing from web/, tools/jdip-import
  # is built alongside because it lives in the same module.
  goSrc = lib.cleanSourceWith {
    src = lib.cleanSource ./.;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      !(type == "directory" && lib.elem name [ "web" ])
      && !lib.elem name [
        "node_modules"
        ".github"
        ".claude"
        "research"
        ".playwright-mcp"
        ".gitignore"
        "flake.nix"
        "flake.lock"
        "package.nix"
      ]
      && !(lib.hasSuffix ".db" name)
      && !(lib.hasSuffix ".db-wal" name)
      && !(lib.hasSuffix ".db-shm" name)
      && !(lib.hasSuffix ".tsbuildinfo" name);
  };

  server = buildGoModule {
    pname = "1901-server";
    inherit version;
    src = goSrc;
    vendorHash = "sha256-UFbEJ+D1lizdtj5pDarrGOO/+RVk8nOGX4DAt4PmgLk=";

    # The DATC corpus is data, not code: `go mod vendor` keeps godip's Go
    # files and drops the .txt case files the test reads from the module
    # directory. Nothing in the sandbox can put them back, so the compliance
    # run stays where it has the whole module — the `datc` job in CI.
    checkFlags = [
      "-skip"
      "TestDATCOnTheLoadedClassicalBoard"
    ];

    # `go install` names the binary after the import path, "spike"; the
    # project knows it as 1901.
    postInstall = ''
      mv $out/bin/spike $out/bin/1901
    '';

    meta = {
      platforms = lib.platforms.linux;
    };
  };
in
symlinkJoin {
  pname = "1901";
  inherit version;

  paths = [ server ];
  nativeBuildInputs = [ makeWrapper ];

  postBuild = ''
    wrapProgram $out/bin/1901 \
      --set-default SPADIR ${web}/share/1901/web/dist \
      --set-default GENERATED_VARIANTS ${goSrc}/variants/generated
  '';

  passthru = {
    inherit web server;
  };

  meta = {
    description = "A face-to-face Diplomacy adjudicator: orders by phone, the server resolves";
    mainProgram = "1901";
    platforms = lib.platforms.linux;
  };
}
