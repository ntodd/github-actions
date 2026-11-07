defmodule Fixture do
  @moduledoc false
  def run, do: String.to_integer(System.get_env("FLAKE_HUNT_RUN", "1"))
end
