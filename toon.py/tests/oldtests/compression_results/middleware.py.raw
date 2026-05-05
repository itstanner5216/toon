"""FastMCP middleware for tri-state governance with scoped elevation and elicitation."""

import asyncio
import hashlib
import time
from typing import Any, Dict, List, Optional

from fastmcp import Context
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware
from loguru import logger

from .audit import audit_logger, AuditEvent
from .config import Config
from .governance.approval import (
    ApprovalDecision,
    ApprovalRequest,
    get_approval_provider,
)
from .governance.artifacts import get_artifact_generator
from .governance.tokens import verify_token
from .leases import lease_manager
from .registry import tool_registry
from .state import ExecutionMode, governance_state
from .toon import encode_output


# Constants
SENSITIVE_TOOLS = {
    # File operations
    "write_file",
    "delete_file",
    "move_file",
    "create_directory",
    "remove_directory",
    # Command execution
    "execute_command",
    # Git operations
    "git_commit",
    "git_push",
    "git_reset",
    # Admin operations
    "set_governance_mode",
    "revoke_all_elevations",
}

ELICITATION_TIMEOUT = Config.ELICITATION_TIMEOUT
DEFAULT_ELEVATION_TTL = Config.DEFAULT_ELEVATION_TTL


class GovernanceMiddleware(Middleware):
    """
    FastMCP middleware for tri-state governance enforcement.

    Enforcement paths:
    - BYPASS: Log warning, audit, execute
    - Non-sensitive: Pass through
    - READ_ONLY: Log denial, audit, raise ToolError
    - PERMISSION: Check elevation → elicit → grant/deny

    Fail-safe rules:
    - Elicitation timeout = denial
    - Elicitation error = denial
    - Unknown mode = denial
    """

    @staticmethod
    def _apply_toon_encoding(result: Any) -> Any:
        """
        Apply TOON encoding to tool result if enabled.

        Args:
            result: Tool execution result

        Returns:
            Encoded result if TOON enabled, otherwise unchanged result
        """
        if not Config.ENABLE_TOON_OUTPUTS:
            return result

        try:
            return encode_output(result, threshold=Config.TOON_ARRAY_THRESHOLD)
        except Exception as e:
            # Fail-safe: return original result if encoding fails
            logger.warning(f"TOON encoding failed: {e}, returning original result")
            return result

    @staticmethod
    def _extract_context_key(tool_name: str, arguments: Dict[str, Any]) -> str:
        """
        Extract context key for scoped elevation.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments

        Returns:
            Context key (path for file ops, command[:50] for commands)
        """
        # Move operation: use source path (MUST check BEFORE general file ops)
        if tool_name == "move_file":
            return arguments.get("source", "unknown")

        # File operations: use path
        if tool_name in {
            "write_file",
            "delete_file",
            "read_file",
        }:
            return arguments.get("path", "unknown")

        # Directory operations: use path
        if tool_name in {"create_directory", "remove_directory", "list_directory"}:
            return arguments.get("path", "unknown")

        # Command execution: use first 50 chars of command
        if tool_name == "execute_command":
            command = arguments.get("command", "unknown")
            return command[:50] if len(command) > 50 else command

        # Git operations: use current directory
        if tool_name.startswith("git_"):
            return arguments.get("cwd", ".")

        # Admin operations: use operation name
        if tool_name in {"set_governance_mode", "revoke_all_elevations"}:
            return tool_name

        # Default: tool name
        return tool_name

    def _compute_elevation_key(
        self, tool_name: str, arguments: Dict[str, Any], session_id: str
    ) -> str:
        """
        Compute elevation key using SHA256 hash.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            session_id: Session identifier

        Returns:
            Elevation hash key
        """
        context_key = self._extract_context_key(tool_name, arguments)
        return governance_state.compute_elevation_hash(
            tool_name=tool_name,
            context_key=context_key,
            session_id=session_id,
        )

    async def _check_elevation(
        self, tool_name: str, arguments: Dict[str, Any], session_id: str
    ) -> bool:
        """
        Check if scoped elevation exists.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            session_id: Session identifier

        Returns:
            True if elevation exists, False otherwise
        """
        elevation_key = self._compute_elevation_key(tool_name, arguments, session_id)
        return await governance_state.check_elevation(elevation_key)

    async def _grant_elevation(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        session_id: str,
        ttl: int = DEFAULT_ELEVATION_TTL,
    ) -> bool:
        """
        Grant scoped elevation.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            session_id: Session identifier
            ttl: Time-to-live for elevation

        Returns:
            True if elevation was granted, False otherwise
        """
        elevation_key = self._compute_elevation_key(tool_name, arguments, session_id)
        context_key = self._extract_context_key(tool_name, arguments)

        # Grant elevation in Redis
        granted = await governance_state.grant_elevation(elevation_key, ttl)

        if granted:
            # Audit elevation grant
            audit_logger.log_elevation_granted(
                tool_name=tool_name,
                context_key=context_key,
                session_id=session_id,
                ttl=ttl,
            )

        return granted

    @staticmethod
    def _generate_request_id(
        session_id: str, tool_name: str, context_key: str
    ) -> str:
        """
        Generate stable request ID for approval requests.

        Format: {session_id_hash}_{tool_name}_{context_hash}_{timestamp_ms}

        Args:
            session_id: Session identifier
            tool_name: Name of the tool
            context_key: Context key (path, command, etc.)

        Returns:
            Stable request ID for this approval request
        """
        # Hash session_id for privacy (first 8 chars)
        session_hash = hashlib.sha256(session_id.encode()).hexdigest()[:8]

        # Hash context_key to keep request_id readable (first 8 chars)
        context_hash = hashlib.sha256(context_key.encode()).hexdigest()[:8]

        # Use monotonic timestamp in milliseconds for uniqueness
        timestamp_ms = int(time.monotonic() * 1000)

        return f"{session_hash}_{tool_name}_{context_hash}_{timestamp_ms}"

    @staticmethod
    def _get_required_scopes(tool_name: str, arguments: Dict[str, Any]) -> List[str]:
        """
        Get required permission scopes for a tool operation.

        Fetches base scopes from tool registry metadata, then adds
        resource-specific scopes based on tool arguments (e.g., specific file paths).

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments

        Returns:
            List of required permission scopes
        """
        # Start with base scopes from registry
        tool_record = tool_registry.get_tool(tool_name)
        if tool_record and tool_record.required_scopes:
            base_scopes = tool_record.required_scopes.copy()
        else:
            # Fallback: generate basic scope if not in registry
            logger.warning(
                f"Tool {tool_name} not found in registry or has no required_scopes, "
                f"using fallback scope"
            )
            base_scopes = [f"tool:{tool_name}"]

        # Add resource-specific scopes based on arguments
        # These are dynamic and depend on actual operation context
        if tool_name in {"write_file", "delete_file", "read_file"}:
            path = arguments.get("path", "")
            if path:
                base_scopes.append(f"resource:path:{path}")

        elif tool_name == "move_file":
            source = arguments.get("source", "")
            dest = arguments.get("destination", "")
            if source:
                base_scopes.append(f"resource:path:{source}")
            if dest:
                base_scopes.append(f"resource:path:{dest}")

        elif tool_name == "execute_command":
            command = arguments.get("command", "")
            if command:
                # Add specific command being executed (first 50 chars)
                cmd_preview = command[:50] if len(command) > 50 else command
                base_scopes.append(f"resource:command:{cmd_preview}")

        elif tool_name in {"create_directory", "list_directory"}:
            path = arguments.get("path", "")
            if path:
                base_scopes.append(f"resource:path:{path}")

        return base_scopes

    @staticmethod
    def _format_approval_request(
        tool_name: str, arguments: Dict[str, Any]
    ) -> str:
        """
        Format approval request in Markdown.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments

        Returns:
            Formatted approval request
        """
        lines = [
            "# Approval Required",
            "",
            f"**Tool:** `{tool_name}`",
            "",
            "**Arguments:**",
        ]

        for key, value in arguments.items():
            # Truncate long values
            value_str = str(value)
            if len(value_str) > 200:
                value_str = value_str[:200] + "..."
            lines.append(f"- `{key}`: {value_str}")

        lines.extend(
            [
                "",
                "**Actions:**",
                "- Type `approve` to execute",
                "- Type `deny` to reject",
                "",
                f"This approval will grant scoped elevation for {DEFAULT_ELEVATION_TTL} seconds.",
            ]
        )

        return "\n".join(lines)

    @staticmethod
    def _parse_approval_response(response: str) -> bool:
        """
        Parse approval response from user with strict word boundary matching.

        Args:
            response: User response string

        Returns:
            True if approved, False if denied

        Security:
            Uses word boundary matching to prevent substring attacks
            (e.g., "yokay" will NOT match "ok", only standalone "ok" matches)
        """
        if not response:
            return False

        normalized = response.strip().lower()

        # Approval indicators (exact word matches only)
        approval_indicators = {"approve", "yes", "accept", "ok", "allow", "y"}

        # Split response into words (whitespace-separated tokens)
        words = normalized.split()

        # Check if any word exactly matches an approval indicator
        for word in words:
            # Remove common punctuation from word boundaries
            cleaned_word = word.strip(".,!?;:'\"")
            if cleaned_word in approval_indicators:
                return True

        # Denial is default (fail-safe)
        return False

    async def _elicit_approval(
        self, ctx: Context, tool_name: str, arguments: Dict[str, Any]
    ) -> tuple[bool, int, List[str]]:
        """
        Elicit approval from user using approval provider system.

        Args:
            ctx: FastMCP context
            tool_name: Name of the tool
            arguments: Tool arguments

        Returns:
            Tuple of (approved, lease_seconds, selected_scopes)
            - approved: True if approved with at least one scope
            - lease_seconds: User-specified lease duration (0 = single-use)
            - selected_scopes: Which scopes the user granted
        """
        session_id = str(ctx.session_id)

        try:
            # Generate stable request_id
            context_key = self._extract_context_key(tool_name, arguments)
            request_id = self._generate_request_id(session_id, tool_name, context_key)

            # Get required scopes for this operation
            required_scopes = self._get_required_scopes(tool_name, arguments)

            # Format approval message
            request_message = self._format_approval_request(tool_name, arguments)

            # Generate approval artifacts (HTML and JSON)
            artifacts_path = None
            try:
                artifact_generator = get_artifact_generator()

                # Generate HTML artifact for GUI display
                html_path = artifact_generator.generate_html_artifact(
                    request_id=request_id,
                    tool_name=tool_name,
                    message=request_message,
                    required_scopes=required_scopes,
                    arguments=arguments,
                    context_metadata={
                        "session_id": session_id,
                        "context_key": context_key,
                    },
                )

                # Generate JSON artifact for programmatic access
                json_path = artifact_generator.generate_json_artifact(
                    request_id=request_id,
                    tool_name=tool_name,
                    message=request_message,
                    required_scopes=required_scopes,
                    arguments=arguments,
                    context_metadata={
                        "session_id": session_id,
                        "context_key": context_key,
                    },
                )

                # Use HTML path for UI (JSON available at same location with .json extension)
                artifacts_path = html_path
                logger.debug(
                    f"Generated approval artifacts for {request_id}: "
                    f"HTML={html_path}, JSON={json_path}"
                )

            except Exception as e:
                # Non-fatal: approval can proceed without artifacts
                logger.warning(
                    f"Failed to generate approval artifacts for {request_id}: {e}"
                )

            # Create approval request
            approval_request = ApprovalRequest(
                request_id=request_id,
                tool_name=tool_name,
                message=request_message,
                required_scopes=required_scopes,
                artifacts_path=artifacts_path,
                timeout_seconds=ELICITATION_TIMEOUT,
                context_metadata={
                    "session_id": session_id,
                    "arguments": arguments,
                    "context_key": context_key,
                },
            )

            # Audit approval request with request_id
            audit_logger.log(
                AuditEvent.APPROVAL_REQUESTED,
                tool_name=tool_name,
                arguments=arguments,
                session_id=session_id,
                request_id=request_id,
                required_scopes=required_scopes,
            )

            # Get approval provider
            provider = await get_approval_provider(context=ctx)
            logger.info(
                f"Using approval provider: {provider.get_name()} "
                f"for {tool_name} (request: {request_id})"
            )

            # Request approval from provider
            response = await provider.request_approval(approval_request)

            # Handle different response decisions
            if response.decision == ApprovalDecision.TIMEOUT:
                logger.warning(
                    f"Approval timeout for {tool_name} "
                    f"(request: {request_id}, session: {session_id})"
                )
                audit_logger.log_approval_timeout(
                    tool_name=tool_name,
                    arguments=arguments,
                    session_id=session_id,
                    request_id=request_id,
                    timeout_seconds=ELICITATION_TIMEOUT,
                )
                return False, 0, []

            elif response.decision == ApprovalDecision.ERROR:
                logger.error(
                    f"Approval error for {tool_name} "
                    f"(request: {request_id}, session: {session_id}): "
                    f"{response.error_message}"
                )
                audit_logger.log_approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    session_id=session_id,
                    request_id=request_id,
                    approved=False,
                    error=response.error_message,
                )
                return False, 0, []

            elif response.decision == ApprovalDecision.DENIED:
                logger.info(
                    f"Approval denied for {tool_name} "
                    f"(request: {request_id}, session: {session_id})"
                )
                audit_logger.log_approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    session_id=session_id,
                    request_id=request_id,
                    approved=False,
                )
                return False, 0, []

            # APPROVED - validate selected scopes
            elif response.decision == ApprovalDecision.APPROVED:
                # Fail-safe: If no scopes selected, deny
                if len(response.selected_scopes) == 0:
                    logger.warning(
                        f"Approval denied for {tool_name}: No scopes selected "
                        f"(request: {request_id}, session: {session_id})"
                    )
                    audit_logger.log_approval(
                        tool_name=tool_name,
                        arguments=arguments,
                        session_id=session_id,
                        request_id=request_id,
                        approved=False,
                        reason="no_scopes_selected",
                    )
                    return False, 0, []

                # CRITICAL SECURITY: Validate ALL required scopes are selected
                # User MUST approve ALL required scopes, not just a subset
                missing_scopes = set(required_scopes) - set(response.selected_scopes)
                if missing_scopes:
                    logger.error(
                        f"Approval denied for {tool_name}: Missing required scopes {missing_scopes} "
                        f"(request: {request_id}, session: {session_id})"
                    )
                    audit_logger.log_approval(
                        tool_name=tool_name,
                        arguments=arguments,
                        session_id=session_id,
                        request_id=request_id,
                        approved=False,
                        reason=f"missing_required_scopes: {list(missing_scopes)}",
                    )
                    return False, 0, []

                # Validate no invalid scopes added (extra scopes not in required)
                invalid_scopes = set(response.selected_scopes) - set(required_scopes)
                if invalid_scopes:
                    logger.error(
                        f"Approval denied for {tool_name}: Invalid scopes {invalid_scopes} "
                        f"(request: {request_id}, session: {session_id})"
                    )
                    audit_logger.log_approval(
                        tool_name=tool_name,
                        arguments=arguments,
                        session_id=session_id,
                        request_id=request_id,
                        approved=False,
                        reason=f"invalid_extra_scopes: {list(invalid_scopes)}",
                    )
                    return False, 0, []

                # All validations passed
                logger.info(
                    f"Approval granted for {tool_name} "
                    f"(request: {request_id}, session: {session_id}, "
                    f"scopes: {response.selected_scopes}, lease: {response.lease_seconds}s)"
                )
                audit_logger.log_approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    session_id=session_id,
                    request_id=request_id,
                    approved=True,
                    selected_scopes=response.selected_scopes,
                    lease_seconds=response.lease_seconds,
                )

                return True, response.lease_seconds, response.selected_scopes

            # Unknown decision - fail-safe deny
            else:
                logger.error(
                    f"Unknown approval decision {response.decision} for {tool_name} "
                    f"(request: {request_id}, session: {session_id})"
                )
                audit_logger.log_approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    session_id=session_id,
                    request_id=request_id,
                    approved=False,
                    reason=f"unknown_decision: {response.decision}",
                )
                return False, 0, []

        except Exception as e:
            # Error = denial (fail-safe)
            logger.error(
                f"Approval elicitation error for {tool_name} (session: {session_id}): {e}",
                exc_info=True,
            )
            audit_logger.log_approval(
                tool_name=tool_name,
                arguments=arguments,
                session_id=session_id,
                approved=False,
                error=str(e),
            )
            return False, 0, []

    async def on_call_tool(self, context: Context, call_next):
        """
        Intercept tool calls and enforce tri-state governance.

        Governance paths:
        1. BYPASS mode: Log warning, audit, execute
        2. Non-sensitive tools: Pass through
        3. READ_ONLY mode: Log denial, audit, raise ToolError
        4. PERMISSION mode: Check elevation → elicit → grant/deny

        Args:
            context: FastMCP context
            call_next: Next middleware in chain

        Returns:
            Tool result if approved/bypassed

        Raises:
            ToolError: If operation is denied
        """
        tool_name = context.request_context.tool_name
        arguments = context.request_context.arguments or {}
        session_id = str(context.session_id)

        # PHASE 3+4 INTEGRATION: Validate lease and token before governance checks
        # Note: Bootstrap tools bypass lease checks
        # CRITICAL: Skip lease checks if ENABLE_LEASE_MANAGEMENT is False
        bootstrap_tools = {"search_tools", "get_tool_schema"}

        if Config.ENABLE_LEASE_MANAGEMENT and tool_name not in bootstrap_tools:
            # Extract client_id from FastMCP session context
            # In FastMCP/MCP protocol, session_id is the stable client connection identifier
            client_id = str(context.session_id)

            # Validate lease exists
            lease = await lease_manager.validate(client_id, tool_name)
            if lease is None:
                logger.warning(
                    f"No valid lease for {tool_name} (client: {client_id}, session: {session_id})"
                )
                raise ToolError(
                    f"No valid lease for tool '{tool_name}'. "
                    f"Please request tool schema first via get_tool_schema('{tool_name}')."
                )

            # PHASE 4: Verify capability token if present
            if lease.capability_token:
                token_valid = verify_token(
                    token=lease.capability_token,
                    client_id=client_id,
                    tool_id=tool_name,
                    secret=Config.HMAC_SECRET,
                    context_key=None,  # No additional context scoping for now
                )

                if not token_valid:
                    logger.error(
                        f"Capability token verification failed for {tool_name} "
                        f"(client: {client_id}, session: {session_id})"
                    )
                    # Revoke invalid lease
                    await lease_manager.revoke(client_id, tool_name)
                    raise ToolError(
                        f"Access to '{tool_name}' denied: Invalid capability token. "
                        f"Lease has been revoked for security."
                    )

                logger.debug(
                    f"Capability token verified for {tool_name} "
                    f"(client: {client_id})"
                )

            # Consume lease (decrement calls_remaining)
            consumed_lease = await lease_manager.consume(client_id, tool_name)
            if consumed_lease is None:
                logger.warning(
                    f"Failed to consume lease for {tool_name} "
                    f"(client: {client_id}, session: {session_id})"
                )
                raise ToolError(
                    f"Lease exhausted for tool '{tool_name}'. "
                    f"Please request a new lease via get_tool_schema('{tool_name}')."
                )

            logger.info(
                f"Lease consumed for {tool_name} "
                f"(client: {client_id}, remaining={consumed_lease.calls_remaining})"
            )

        # Get current governance mode
        mode = await governance_state.get_mode()

        # Audit tool invocation
        audit_logger.log_tool_call(
            tool_name=tool_name,
            arguments=arguments,
            session_id=session_id,
            mode=mode.value,
        )

        # Path 1: BYPASS mode - execute all tools
        if mode == ExecutionMode.BYPASS:
            logger.warning(
                f"BYPASS mode: Executing {tool_name} without governance (session: {session_id})"
            )
            audit_logger.log_bypass(
                tool_name=tool_name,
                arguments=arguments,
                session_id=session_id,
            )
            result = await call_next()
            return self._apply_toon_encoding(result)

        # Path 2: Non-sensitive tools - pass through
        if tool_name not in SENSITIVE_TOOLS:
            logger.debug(f"Non-sensitive tool {tool_name}, passing through")
            result = await call_next()
            return self._apply_toon_encoding(result)

        # Path 3: READ_ONLY mode - block sensitive operations
        if mode == ExecutionMode.READ_ONLY:
            logger.warning(
                f"READ_ONLY mode: Blocking {tool_name} (session: {session_id})"
            )
            audit_logger.log_blocked(
                tool_name=tool_name,
                arguments=arguments,
                session_id=session_id,
                reason="read_only_mode",
            )
            raise ToolError(
                f"Operation '{tool_name}' blocked: System is in READ_ONLY mode"
            )

        # Path 4: PERMISSION mode - check elevation or elicit
        if mode == ExecutionMode.PERMISSION:
            # Check if scoped elevation exists
            has_elevation = await self._check_elevation(
                tool_name, arguments, session_id
            )

            if has_elevation:
                # Elevation exists, allow execution
                context_key = self._extract_context_key(tool_name, arguments)
                logger.info(
                    f"Using scoped elevation for {tool_name} (context: {context_key}, session: {session_id})"
                )
                audit_logger.log_elevation_used(
                    tool_name=tool_name,
                    context_key=context_key,
                    session_id=session_id,
                )
                result = await call_next()
                return self._apply_toon_encoding(result)

            # No elevation, elicit approval
            logger.info(
                f"Eliciting approval for {tool_name} (session: {session_id})"
            )
            approved, lease_seconds, selected_scopes = await self._elicit_approval(
                context, tool_name, arguments
            )

            if approved:
                # Honor user-specified lease duration
                # If lease_seconds == 0, skip elevation grant (single-use approval)
                if lease_seconds > 0:
                    # Grant scoped elevation with user-specified TTL
                    await self._grant_elevation(
                        tool_name, arguments, session_id, ttl=lease_seconds
                    )
                    logger.info(
                        f"Approval granted with elevation for {tool_name} "
                        f"(session: {session_id}, ttl: {lease_seconds}s, scopes: {selected_scopes})"
                    )
                else:
                    # Single-use approval (no elevation grant)
                    logger.info(
                        f"Approval granted (single-use, no elevation) for {tool_name} "
                        f"(session: {session_id}, scopes: {selected_scopes})"
                    )

                # Execute tool
                result = await call_next()
                return self._apply_toon_encoding(result)
            else:
                # Denied - audit already logged in _elicit_approval
                logger.warning(f"Approval denied for {tool_name} (session: {session_id})")
                raise ToolError(
                    f"Operation '{tool_name}' denied: User did not approve"
                )

        # Fail-safe: Unknown mode - deny
        logger.error(f"Unknown governance mode: {mode}, denying {tool_name}")
        audit_logger.log_blocked(
            tool_name=tool_name,
            arguments=arguments,
            session_id=session_id,
            reason=f"unknown_mode_{mode}",
        )
        raise ToolError(
            f"Operation '{tool_name}' denied: Unknown governance mode"
        )
