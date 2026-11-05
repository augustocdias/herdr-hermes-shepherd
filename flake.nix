{
  description = "Hermes Shepherd: a Herdr App tab that shows a live Hermes kanban board";

  outputs = _: {
    homeManagerModules.default = import ./home-manager.nix;
  };
}
