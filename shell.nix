{ pkgs ? import (builtins.fetchTarball {
  name = "nixpkgs-unstable-2023-02-26";
  url = "https://github.com/nixos/nixpkgs/archive/f5dad40450d272a1ea2413f4a67ac08760649e89.tar.gz";
  sha256 = "06nq3rn63csy4bx0dkbg1wzzm2jgf6cnfixq1cx4qikpyzixca6i"; # Hash obtained using `nix-prefetch-url --unpack <url>`
}) {} }:

with pkgs;

mkShell {
  buildInputs = [
    gnupg
    nodejs-19_x
    nodePackages.pnpm
  ];

  shellHook =
    ''
      # Setup the terminal prompt.
      export PS1="(nix-shell) \W $ "

      # Hide NodeJS 19 warnings.
      export NODE_NO_WARNINGS=1

      # Clear the terminal screen.
      pnpm i
      clear
    '';
}
