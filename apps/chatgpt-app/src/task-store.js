export async function readTask(env, taskId) {
  const response = await taskStub(env, taskId).fetch("https://task/task");
  if (!response.ok) throw new Error("task not found");
  return response.json();
}

export async function writeTask(env, task) {
  const response = await taskStub(env, task.id).fetch("https://task/task", {
    method: "POST",
    body: JSON.stringify(task),
  });
  if (!response.ok) throw new Error("task write failed");
  return response.json();
}

export async function updateTask(env, taskId, event) {
  const response = await taskStub(env, taskId).fetch("https://task/task", {
    method: "PATCH",
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error("task update failed");
  return response.json();
}

export async function claimTaskDispatch(env, taskId, repositoryAccess) {
  const response = await taskStub(env, taskId).fetch(
    "https://task/task/claim-dispatch",
    {
      method: "POST",
      body: JSON.stringify({ repositoryAccess }),
    },
  );
  if (!response.ok) throw new Error("task dispatch claim failed");
  return response.json();
}

export async function commitTaskDispatch(env, taskId) {
  const response = await taskStub(env, taskId).fetch(
    "https://task/task/commit-dispatch",
    { method: "POST" },
  );
  if (!response.ok) throw new Error("task dispatch commit failed");
  return response.json();
}

function taskStub(env, taskId) {
  return env.TASKS.get(env.TASKS.idFromName(taskId));
}
