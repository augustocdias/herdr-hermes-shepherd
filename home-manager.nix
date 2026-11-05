{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.hermes-shepherd;
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
      "herdr-app/mods/hermes-shepherd/main.js".source = ./mods/hermes-shepherd/main.js;
      "herdr-app/mods/hermes-shepherd/mod.json".source = ./mods/hermes-shepherd/mod.json;
      "herdr-app/mods/hermes-shepherd/icon.svg".source = ./mods/hermes-shepherd/icon.svg;
      "herdr-app/mods/hermes-shepherd/coordinator.svg".source = ./mods/hermes-shepherd/coordinator.svg;
      "herdr-app/mods/hermes-shepherd/cron.svg".source = ./mods/hermes-shepherd/cron.svg;
    };
    home.packages = [
      (pkgs.writeShellScriptBin "hermes-shepherd-board" ''
        exec ${cfg.hermesPython} ${./board/hermes_shepherd_board.py} "$@"
      '')
      (pkgs.writeShellScriptBin "hermes-shepherd-cron" ''
        exec ${cfg.hermesPython} ${./board/hermes_shepherd_cron.py} "$@"
      '')
    ];
  };
}
