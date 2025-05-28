import requests
from typing import Any, Dict, Optional, List


class CoqProjectClient:
    def __init__(self, base_url: str) -> None:
        """
        Initialize the client with the base URL of the server.
        :param base_url: The base URL pointing to the Coq project server.
        """
        self.base_url = base_url.rstrip("/")

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Internal helper to perform a GET request.
        :param path: URL path to append to the base url.
        :param params: Query parameters for the GET request.
        :return: The JSON response as a dictionary.
        """
        url = f"{self.base_url}{path}"
        response = requests.get(url, params=params)
        response.raise_for_status()
        return response.json()

    def get_project_root(self) -> Dict[str, Any]:
        """
        Returns the project root directory information.
        Path: GET /
        """
        return self._get("/")

    def get_theorem_names(self, file_path: str, session_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Retrieves theorem names from a specified file, optionally using a session's auxiliary file.
        Path: GET /theorem-names
        """
        params = {"filePath": file_path}
        if session_id:
            params["coqSessionId"] = session_id
        return self._get("/theorem-names", params=params)

    def get_all_coq_files(self) -> Dict[str, Any]:
        """
        Returns a list of all Coq files in the project.
        Path: GET /all-coq-files
        """
        return self._get("/all-coq-files")

    def get_session_theorem(self, session_id: str, proof_version_hash: str) -> Dict[str, Any]:
        """
        Retrieves theorem information from a specific session and proof version.
        Path: GET /session-theorem
        """
        params = {"coqSessionId": session_id, "proofVersionHash": proof_version_hash}
        return self._get("/session-theorem", params=params)

    def get_theorem(self, file_path: str, theorem_name: str, session_id: str, proof_version_hash: str) -> Dict[
        str, Any]:
        """
        Retrieves complete theorem with proof from a source file.
        Path: GET /theorem
        """
        params = {"filePath": file_path, "theoremName": theorem_name, "coqSessionId": session_id,
                  "proofVersionHash": proof_version_hash}
        return self._get("/theorem", params=params)

    def check_proof(self, proof: str, session_id: str, proof_version_hash: str) -> Dict[str, Any]:
        """
        Validates a proof in the context of a session and returns goals/errors.
        Path: GET /check-proof
        """
        params = {
            "proof": proof,
            "coqSessionId": session_id,
            "proofVersionHash": proof_version_hash
        }
        return self._get("/check-proof", params=params)

    def get_objects(self, session_id: str) -> Dict[str, Any]:
        """
        Gets objects in the current session.
        Path: GET /get-objects
        """
        params = {"coqSessionId": session_id}
        return self._get("/get-objects", params=params)

    def search_pattern(self, pattern: str, session_id: str) -> Dict[str, Any]:
        """
        Searches for a pattern in the current session.
        Path: GET /search-pattern
        """
        params = {"pattern": pattern, "coqSessionId": session_id}
        return self._get("/search-pattern", params=params)

    def print_term(self, term: str, session_id: str) -> Dict[str, Any]:
        """
        Prints a term in the current session.
        Path: GET /print-term
        """
        params = {"term": term, "coqSessionId": session_id}
        return self._get("/print-term", params=params)

    def check_term(self, term: str, session_id: str) -> Dict[str, Any]:
        """
        Checks a term in the current session.
        Path: GET /check-term
        """
        params = {"term": term, "coqSessionId": session_id}
        return self._get("/check-term", params=params)

    def get_premises(self, goal: str, file_path: str, session_id: str, max_number_of_premises: int = 20) -> Dict[
        str, Any]:
        """
        Retrieves premises (dependencies) for a theorem from a file.
        Path: GET /get-premises
        """
        params = {
            "goal": goal,
            "filePath": file_path,
            "coqSessionId": session_id,
            "maxNumberOfPremises": max_number_of_premises
        }
        return self._get("/get-premises", params=params)

    def start_session(self, file_path: str, theorem_name: str) -> Dict[str, Any]:
        """
        Initializes a new proof session for a theorem.
        Path: GET /start-session
        """
        params = {"filePath": file_path, "theoremName": theorem_name}
        return self._get("/start-session", params=params)

    def get_session(self, session_id: str) -> Dict[str, Any]:
        """
        Retrieves information about a specific session.
        Path: GET /get-session
        """
        params = {"coqSessionId": session_id}
        return self._get("/get-session", params=params)

    def finish_session(self, session_id: str) -> Dict[str, Any]:
        """
        Closes a session and cleans up associated resources.
        Path: GET /finish-session
        """
        params = {"coqSessionId": session_id}
        return self._get("/finish-session", params=params)

    def get_proof_version_by_hash(self, session_id: str, proof_version_hash: str) -> Dict[str, Any]:
        """
        Retrieves a specific proof version by its hash.
        Path: GET /proof-version-by-hash
        """
        params = {"coqSessionId": session_id, "proofVersionHash": proof_version_hash}
        return self._get("/proof-version-by-hash", params=params)

    def get_proof_history(self, session_id: str) -> Dict[str, Any]:
        """
        Returns the complete proof history tree for a session.
        Path: GET /proof-history
        """
        params = {"coqSessionId": session_id}
        return self._get("/proof-history", params=params)
