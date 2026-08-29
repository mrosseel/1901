# 1901 — a face-to-face Diplomacy adjudicator.
#
# nix develop      the toolchain the CI runs: go, node, govulncheck
# nix build        the packaged server: binary + built frontend + placements
# nix run          the same, started in place
#
# The go line in go.mod is the minimum the build accepts; this input is
# pinned well past it, so dev, CI, and the server all run one toolchain.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            go
            nodejs_24
            govulncheck
          ];
        };
      });

      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./package.nix { };
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.system}.default}/bin/1901";
        };
      });
    };
}
