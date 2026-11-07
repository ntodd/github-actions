# An ExUnit formatter that appends one JSON line per test to $FLAKE_HUNT_OUT.
#
# hunt.sh loads it before Mix starts, so the project under test needs no
# dependency or config change:
#
#     elixir -r flake_formatter.exs -S mix test \
#       --formatter ExUnit.CLIFormatter --formatter FlakeHunt.Formatter
#
# Needs Elixir 1.18 or newer, for the JSON module.

unless Code.ensure_loaded?(JSON) do
  raise "flake-hunt needs Elixir 1.18 or newer (for JSON), not #{System.version()}"
end

defmodule FlakeHunt.Formatter do
  @moduledoc false
  use GenServer

  @max_message 4_000

  @impl true
  def init(_opts) do
    path = System.fetch_env!("FLAKE_HUNT_OUT")
    File.mkdir_p!(Path.dirname(path))
    {:ok, io} = File.open(path, [:append, :utf8])

    {:ok,
     %{
       io: io,
       seed: nil,
       root: System.get_env("FLAKE_HUNT_ROOT") || File.cwd!(),
       run: int_env("FLAKE_HUNT_RUN"),
       shard: int_env("FLAKE_HUNT_SHARD")
     }}
  end

  @impl true
  def handle_cast({:suite_started, opts}, state), do: {:noreply, %{state | seed: opts[:seed]}}

  def handle_cast({:test_finished, %ExUnit.Test{} = test}, state) do
    case outcome(test) do
      {status, message} ->
        record =
          %{
            type: "test",
            module: inspect(test.module),
            name: to_string(test.name),
            file: Path.relative_to(test.tags.file, state.root),
            line: test.tags.line,
            status: status,
            time_us: test.time,
            seed: state.seed,
            run: state.run,
            shard: state.shard
          }
          |> put_message(message)

        IO.write(state.io, [JSON.encode!(record), ?\n])

      :ignore ->
        :ok
    end

    {:noreply, state}
  end

  def handle_cast(_event, state), do: {:noreply, state}

  defp outcome(%ExUnit.Test{state: nil}), do: {"passed", nil}

  defp outcome(%ExUnit.Test{state: {:failed, failures}} = test) do
    {"failed", message(fn -> ExUnit.Formatter.format_test_failure(test, failures, 1, 100, &plain/2) end)}
  end

  # A setup_all failure marks every test in the module invalid.
  defp outcome(%ExUnit.Test{state: {:invalid, %ExUnit.TestModule{state: {:failed, failures}} = module}}) do
    {"failed", message(fn -> ExUnit.Formatter.format_test_all_failure(module, failures, 1, 100, &plain/2) end)}
  end

  defp outcome(%ExUnit.Test{state: {:invalid, _}}), do: {"failed", "setup_all failed"}
  defp outcome(%ExUnit.Test{}), do: :ignore

  # No colors and no diffs: the message goes into an issue, not a terminal.
  defp plain(:diff_enabled?, _), do: false
  defp plain(_key, msg), do: msg

  defp message(fun) do
    fun.() |> IO.iodata_to_binary() |> String.slice(0, @max_message)
  rescue
    e -> "(flake-hunt couldn't format this failure: #{Exception.message(e)})"
  end

  defp put_message(record, nil), do: record
  defp put_message(record, message), do: Map.put(record, :message, message)

  defp int_env(name) do
    case System.get_env(name) do
      nil -> nil
      value -> String.to_integer(value)
    end
  end
end
