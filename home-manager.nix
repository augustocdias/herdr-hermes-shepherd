{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.hermes-shepherd;
  # Herdr refuses relative imports that resolve through separate store symlinks.
  bundledMod = pkgs.runCommand "hermes-shepherd.js" {
    nativeBuildInputs = [pkgs.esbuild];
  } ''
    esbuild ${./mods/hermes-shepherd}/main.js --bundle --format=esm \
      --external:gpui-kit --external:gpui-base --external:herdr --external:net --external:buffer \
      --outfile="$out"
  '';
in {
  options.programs.hermes-shepherd = {
    enable = lib.mkEnableOption "the Hermes Shepherd tab for Herdr App";
    hermesPython = lib.mkOption {
      type = lib.types.str;
      example = lib.literalExpression ''"''${inputs.hermes-agent.packages.''${system}.default.hermesVenv}/bin/python3"'';
      description = "Python interpreter of the Hermes installation whose boards the tab shows; it must import `hermes_cli`.";
    };
  };

  config = lib.mkIf cfg.enable {
    xdg.configFile = {
      "herdr-app/mods/hermes-shepherd/main.js".source = bundledMod;
      "herdr-app/mods/hermes-shepherd/mod.json".source = ./mods/hermes-shepherd/mod.json;
    };
    home.packages = [
      (pkgs.writeShellScriptBin "hermes-shepherd-board" ''
        exec ${cfg.hermesPython} ${./board/hermes_shepherd_board.py} "$@"
      '')
      (pkgs.writeShellScriptBin "hermes-shepherd-cron" ''
        exec ${cfg.hermesPython} ${./board/hermes_shepherd_cron.py} "$@"
      '')
      (pkgs.writeShellScriptBin "hermes-shepherd-chat" ''
        exec ${cfg.hermesPython} ${./chat/hermes_shepherd_chat.py} "$@"
      '')
    ];
  };
}
