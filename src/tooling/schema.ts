import { Type } from "typebox";

// Shared by target-bound tool adapters; routing remains in Go.
export const environmentParameters = {
  environmentId: Type.String({ minLength: 1, description: "Registered environment ID, such as local or remote." }),
};
