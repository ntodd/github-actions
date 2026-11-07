# The flake-hunt integration test runs this suite several times. FLAKE_HUNT_RUN
# is the run number, so "flaky" here means "fails on even runs".
defmodule FixtureTest do
  use ExUnit.Case, async: true

  test "stable" do
    assert 1 + 1 == 2
  end

  test "flaky on even runs" do
    assert rem(Fixture.run(), 2) == 1, "even run #{Fixture.run()}"
  end

  test "always fails" do
    flunk("broken")
  end

  @tag :skip
  test "skipped" do
  end

  describe "group" do
    test "nested" do
      assert true
    end
  end
end

defmodule FixtureSetupAllTest do
  use ExUnit.Case, async: true

  setup_all do
    if rem(Fixture.run(), 2) == 0, do: raise("setup_all failed on run #{Fixture.run()}")
    :ok
  end

  test "behind setup_all" do
    assert true
  end
end
