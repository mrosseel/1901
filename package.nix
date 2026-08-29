# 1901, packaged: one binary, the built frontend beside it, and the
# placements directory the server reads at startup. The wrapper wires the
# three together; every env override (ADDR, DB, BASE_URL, MAX_GAMES,
# SPADIR, PLACEMENTS) still works on top.
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
    hash = "sha256-sCIX+tRlbfsrxEQQFJ2nt5Amef2Ufx/ZNT/DPRlfTP8=";
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

    buildPhase = ''
      runHook preBuild
      npm run build
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
    vendorHash = "sha256-uKBAPllqABZk/AaszQtHRBBAzZWInKmAzfRqTZpx1qw=";

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
      --set-default PLACEMENTS ${goSrc}/placements
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
